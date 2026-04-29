import { Router } from "express";
import { LoginBody, GetAuthStatusResponse } from "@workspace/api-zod";
import { isAuthenticated } from "../lib/demo-data";

const router = Router();

const DEMO_MODE = !process.env.BYBIT_API_KEY || !process.env.BYBIT_API_SECRET;
const APP_PASSWORD = process.env.APP_PASSWORD ?? "demo123";

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  if (parsed.data.password !== APP_PASSWORD) {
    res.status(401).json({ error: "Contraseña incorrecta" });
    return;
  }
  req.session.authenticated = true;
  res.json(GetAuthStatusResponse.parse({ authenticated: true, demoMode: DEMO_MODE }));
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  req.session.destroy(() => {});
  res.json({ success: true });
});

router.get("/auth/status", async (req, res): Promise<void> => {
  res.json(GetAuthStatusResponse.parse({ authenticated: true, demoMode: DEMO_MODE }));
});

export default router;
