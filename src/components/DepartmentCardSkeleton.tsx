export function DepartmentCardSkeleton() {
  return (
    <div className="department-card skeleton-card" aria-hidden="true">
      <div className="skeleton-line skeleton-short" />
      <div className="skeleton-line skeleton-title" />
      <div className="skeleton-line skeleton-copy" />
      <div className="skeleton-panel" />
      <div className="skeleton-line skeleton-footer" />
    </div>
  );
}
