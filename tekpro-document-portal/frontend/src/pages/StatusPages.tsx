import { Link } from "react-router-dom";
import { EmptyState } from "../components/ui";

export function AccessDeniedPage() {
  return (
    <EmptyState title="Access denied">
      <p>You do not have permission to view this page. If you believe this is a mistake, contact your Tekpro administrator.</p>
      <Link to="/">Return to the dashboard</Link>
    </EmptyState>
  );
}

export function NotFoundPage() {
  return (
    <EmptyState title="Page not found">
      <p>The page you requested does not exist or is no longer available.</p>
      <Link to="/">Return to the dashboard</Link>
    </EmptyState>
  );
}
