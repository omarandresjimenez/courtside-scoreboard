import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AdminDashboard } from './routes/AdminDashboard.js';
import { UmpireScreen } from './routes/UmpireScreen.js';
import { TvScreen } from './routes/TvScreen.js';
import { JoinScreen } from './routes/JoinScreen.js';
import { NotFound } from './routes/NotFound.js';

/** Routes mirror Set 04's three roles — admin, umpire, and the court-scoped TV screen.
 * /umpire and /tv (no id) are the generic, bookmarkable code-entry landing
 * pages a device uses instead of the direct link — see JoinScreen. */
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/admin" replace />} />
        <Route path="/admin" element={<AdminDashboard />} />
        <Route path="/umpire" element={<JoinScreen role="umpire" />} />
        <Route path="/umpire/:matchId" element={<UmpireScreen />} />
        <Route path="/tv" element={<JoinScreen role="tv" />} />
        <Route path="/tv/court/:courtId" element={<TvScreen />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
