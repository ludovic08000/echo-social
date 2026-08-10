import { lazy, Suspense } from "react";
import { Link, useLocation } from "react-router-dom";
import { Home } from "lucide-react";
import { Button } from "@/components/ui/button";

const DeviceMessagingTest = lazy(() => import("./DeviceMessagingTest"));

const NotFound = () => {
  const location = useLocation();

  // Temporary isolated diagnostic route. Keeping it behind the wildcard avoids
  // touching the production messaging route table or the Windows/iOS runtimes.
  if (location.pathname === "/diagnostics/device-messaging") {
    return (
      <Suspense fallback={<div className="min-h-screen grid place-items-center bg-background">Chargement du diagnostic…</div>}>
        <DeviceMessagingTest />
      </Suspense>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-gradient mb-4">404</h1>
        <p className="text-xl text-muted-foreground mb-8">
          Page non trouvée
        </p>
        <Link to="/">
          <Button className="pulse-button-gradient">
            <Home className="w-4 h-4 mr-2" />
            Retour à l'accueil
          </Button>
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
