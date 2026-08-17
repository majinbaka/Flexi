import { Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { HomePage } from './pages/HomePage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { MODULE_NAV_ITEMS } from './modules';

/**
 * Route table: one path per module (plus the home index route), each
 * rendering a placeholder page inside the shared sidebar Layout. A
 * catch-all route covers any unmatched path so navigating there renders
 * NotFoundPage instead of a blank screen.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<HomePage />} />
        {MODULE_NAV_ITEMS.map((item) => (
          <Route
            key={item.id}
            path={item.id}
            element={<PlaceholderPage moduleId={item.id} />}
          />
        ))}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
