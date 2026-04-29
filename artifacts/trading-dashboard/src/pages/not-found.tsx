import { AlertIcon } from "@/components/TradeIcons";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background">
      <div className="w-full max-w-md mx-4 bg-card border border-border rounded-2xl p-8">
        <div className="flex items-center gap-3 mb-4">
          <AlertIcon size={32} className="text-destructive" />
          <h1 className="text-2xl font-bold text-foreground">404 — No encontrado</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Esta página no existe. ¿Olvidaste añadirla al router?
        </p>
      </div>
    </div>
  );
}
