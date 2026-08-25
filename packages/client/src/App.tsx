import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AdminDashboard } from './routes/AdminDashboard.js';
import { UmpireScreen } from './routes/UmpireScreen.js';
import { TvScreen } from './routes/TvScreen.js';
import { NotFound } from './routes/NotFound.js';

/** Routes mirror Set 04's three roles — admin, umpire, and the court-scoped TV screen. */
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/admin" replace />} />
        <Route path="/admin" element={<AdminDashboard />} />
        <Route path="/umpire/:matchId" element={<UmpireScreen />} />
        <Route path="/tv/court/:courtId" element={<TvScreen />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
