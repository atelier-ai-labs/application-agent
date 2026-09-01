import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { CareerAgentPage } from "../application-agent/src/ui/CareerAgentPage";
import { ApplicationAgentPage } from "../application-agent/src/ui/ApplicationAgentPage";
import { DepartmentPage } from "./pages/DepartmentPage";
import { LandingPage } from "./pages/LandingPage";

export function AppRoutes() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/career-agent" element={<CareerAgentPage />} />
        <Route path="/career-agent/:campaignId" element={<CareerAgentPage />} />
        <Route path="/application-agent" element={<ApplicationAgentPage />} />
        <Route path="/application-agent/campaigns" element={<CareerAgentPage />} />
        <Route path="/application-agent/campaigns/:campaignId" element={<CareerAgentPage />} />
        <Route path="/application-agent/:applicationId" element={<ApplicationAgentPage />} />
        <Route path="/departments/application-agent" element={<ApplicationAgentPage />} />
        <Route path="/departments/application-agent/campaigns" element={<CareerAgentPage />} />
        <Route path="/departments/application-agent/campaigns/:campaignId" element={<CareerAgentPage />} />
        <Route path="/departments/application-agent/:applicationId" element={<ApplicationAgentPage />} />
        <Route path="/departments/:departmentId" element={<DepartmentPage />} />
        <Route path="*" element={<Navigate replace to="/" />} />
      </Routes>
    </AppShell>
  );
}

export default function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AppRoutes />
    </BrowserRouter>
  );
}
