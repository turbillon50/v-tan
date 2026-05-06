import { useState } from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { TradingModeProvider } from "@/contexts/TradingModeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { SplashScreen } from "@/components/SplashScreen";

import Dashboard from "@/pages/dashboard";
import Bot from "@/pages/bot";
import Capital from "@/pages/capital";
import Curve from "@/pages/curve";
import Simple from "@/pages/simple";
import Backtest from "@/pages/backtest";
import Alertas from "@/pages/alertas";
import Furtivo from "@/pages/furtivo";
import Manual from "@/pages/manual";
import Historial from "@/pages/historial";
import Live from "@/pages/live";
import Monitor from "@/pages/monitor";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10_000 } },
});

function Router() {
  return (
    <Switch>
      <Route path="/">
        <Redirect to="/panel" />
      </Route>
      <Route path="/panel"     component={Simple}    />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/bot"       component={Bot}       />
      <Route path="/capital"   component={Capital}   />
      <Route path="/curva"     component={Curve}     />
      <Route path="/backtest"  component={Backtest}  />
      <Route path="/alertas"   component={Alertas}   />
      <Route path="/furtivo"   component={Furtivo}   />
      <Route path="/manual"    component={Manual}    />
      <Route path="/historial" component={Historial} />
      <Route path="/live"      component={Live}      />
      <Route path="/monitor"   component={Monitor}   />
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  const skipSplash = new URLSearchParams(window.location.search).has("nosplash");
  const [splashDone, setSplashDone] = useState(skipSplash);

  return (
    <>
      {!splashDone && <SplashScreen onDone={() => setSplashDone(true)} />}
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <TradingModeProvider>
            <TooltipProvider>
              <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                <Router />
              </WouterRouter>
              <Toaster />
            </TooltipProvider>
          </TradingModeProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </>
  );
}
