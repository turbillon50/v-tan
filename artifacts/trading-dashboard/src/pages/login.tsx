import { useState } from "react";
import { useLocation } from "wouter";
import { useLogin, useGetAuthStatus } from "@workspace/api-client-react";
import { TerminalCmdIcon, LockIcon } from "@/components/TradeIcons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function Login() {
  const [, setLocation] = useLocation();
  const [password, setPassword] = useState("");
  const login = useLogin();
  const { data: auth } = useGetAuthStatus();

  if (auth?.authenticated) {
    setLocation("/dashboard");
    return null;
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    login.mutate(
      { data: { password } },
      {
        onSuccess: () => setLocation("/dashboard"),
      }
    );
  };

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center font-mono text-primary p-4">
      <div className="w-full max-w-md border border-primary p-8 bg-card shadow-2xl shadow-primary/20 relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-1 bg-primary/30">
          <div className="h-full bg-primary w-1/3 animate-pulse" />
        </div>
        
        <div className="flex flex-col items-center mb-8">
          <TerminalCmdIcon className="h-16 w-16 mb-4 text-primary" />
          <h1 className="text-4xl font-bold tracking-widest text-center">CRYPTEX</h1>
          <p className="text-xs mt-2 opacity-70">QUANTITATIVE TRADING TERMINAL V1.0.0</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <label className="text-xs uppercase flex items-center gap-2">
              <LockIcon className="h-3 w-3" />
              Authentication Required
            </label>
            <Input
              type="password"
              placeholder="ENTER PASSKEY..."
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-black border-primary text-primary font-mono rounded-none focus-visible:ring-primary placeholder:text-primary/30 h-12"
              data-testid="input-password"
            />
          </div>

          <Button
            type="submit"
            disabled={login.isPending || !password}
            className="w-full h-12 rounded-none bg-primary text-black hover:bg-primary/90 font-bold uppercase tracking-widest"
            data-testid="button-login"
          >
            {login.isPending ? "AUTHENTICATING..." : "INITIALIZE LINK"}
          </Button>

          {login.isError && (
            <div className="text-destructive text-center text-xs font-bold border border-destructive bg-destructive/10 p-2">
              ACCESS DENIED. INVALID CREDENTIALS.
            </div>
          )}
        </form>

        <div className="mt-8 text-[10px] text-primary/50 text-center uppercase">
          <p>UNAUTHORIZED ACCESS IS STRICTLY PROHIBITED.</p>
          <p>ALL ACTIVITIES ARE MONITORED AND LOGGED.</p>
        </div>
      </div>
    </div>
  );
}
