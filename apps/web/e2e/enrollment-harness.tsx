import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccountPanel } from "../src/app/account/account-panel";
// Local test bundle only; no product authentication bypass route.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main className="shell auth-shell">
      <AccountPanel
        eventId="22222222-2222-4222-8222-222222222222"
        termsDocument={null}
        enrollmentEnabled
      />
    </main>
  </StrictMode>,
);
