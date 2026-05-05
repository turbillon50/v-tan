/**
 * Tesis v4.1 — limpieza quirúrgica de tanit_memory
 *
 * El bug: seedTanitIdentity hace UPSERT buscando por `content LIKE 'tag%'`,
 * pero los tags se acortaron a lo largo del tiempo (p.ej. tag "POR QUÉ
 * EXISTEN LOS PERPS" busca prefix "POR QUÉ EXISTEN LOS PERPS%" pero el
 * content guardado empieza con "POR QUÉ EXISTEN LOS PERPETUALS"). El LIKE
 * nunca encuentra y cada arranque INSERTA una fila nueva, generando
 * 1,660+ duplicados en categoría 'identidad'.
 *
 * Este script es idempotente: corre las veces que necesite, solo borra
 * duplicados exactos por (category, content). Mantiene la fila con el
 * id más bajo de cada grupo (la primera que se insertó). Las categorías
 * protegidas (usuario, origen, LECCION_CRITICA, leccion, lesson_critical)
 * NO tienen duplicados así que no se tocan.
 *
 * Cómo ejecutar:
 *   DATABASE_URL='postgresql://...' node scripts/dedupe-tanit-memory.mjs
 *
 * Verificación esperada:
 *   antes: 1,821 filas
 *   después: 161 filas únicas
 *   borradas: 1,660 duplicados de 'identidad'
 */
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL);

async function run() {
  console.log("== PRE-MIGRATION snapshot ==");
  const pre = await sql`SELECT COUNT(*) AS n FROM tanit_memory`;
  console.log("  total rows:", pre[0].n);

  const preBy = await sql`SELECT category, COUNT(*)::int AS n FROM tanit_memory GROUP BY category ORDER BY n DESC`;
  console.log("  by category:");
  preBy.forEach(r => console.log(`    ${r.category}: ${r.n}`));

  // Confirmar que las categorías protegidas no van a perder filas
  const protectedCats = ["usuario", "origen", "LECCION_CRITICA", "leccion", "lesson_critical"];
  const protectedDups = await sql`
    SELECT category, COUNT(*) AS copies
    FROM tanit_memory
    WHERE category = ANY(${protectedCats})
    GROUP BY category, content
    HAVING COUNT(*) > 1
  `;
  if (protectedDups.length > 0) {
    console.error("ABORT: Found duplicates in PROTECTED categories. Aborting:");
    console.error(protectedDups);
    process.exit(2);
  }
  console.log("  protected categories: 0 duplicates ✓ (safe to dedupe)");

  console.log("\n== EXECUTING dedupe — keep MIN(id) per (category, content) ==");
  const result = await sql`
    DELETE FROM tanit_memory
    WHERE id NOT IN (
      SELECT MIN(id) FROM tanit_memory GROUP BY category, content
    )
    RETURNING id, category
  `;
  console.log(`  deleted ${result.length} duplicate rows`);

  // Distribution of what got deleted
  const deletedByCat = result.reduce((acc, r) => { acc[r.category] = (acc[r.category] || 0) + 1; return acc; }, {});
  console.log("  deletions by category:");
  Object.entries(deletedByCat).sort((a, b) => b[1] - a[1]).forEach(([cat, n]) => console.log(`    ${cat}: ${n}`));

  console.log("\n== POST-MIGRATION sanity ==");
  const post = await sql`SELECT COUNT(*) AS n FROM tanit_memory`;
  console.log("  total rows:", post[0].n);
  const postBy = await sql`SELECT category, COUNT(*)::int AS n FROM tanit_memory GROUP BY category ORDER BY n DESC`;
  console.log("  by category:");
  postBy.forEach(r => console.log(`    ${r.category}: ${r.n}`));

  // Verify the 15 personal memories survived
  const personal = await sql`
    SELECT id, category, SUBSTRING(content FROM 1 FOR 80) AS preview
    FROM tanit_memory
    WHERE category IN ('usuario', 'origen', 'LECCION_CRITICA', 'leccion', 'lesson_critical')
    ORDER BY category, id
  `;
  console.log("\n== Personal memories preserved ==");
  personal.forEach(p => console.log(`  id=${p.id} [${p.category}] ${p.preview}...`));
  console.log(`  total personal: ${personal.length}`);

  console.log("\n== DONE ==");
}

run().catch(e => { console.error("FAILED:", e); process.exit(1); });
