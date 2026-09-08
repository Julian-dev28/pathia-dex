import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="page-head" style={{ paddingTop: 40 }}>
      <h1 className="page-title">Not found</h1>
      <p className="page-sub">No such page.</p>
      <p className="mt-3">
        <Link href="/">Back to the terminal</Link>
      </p>
    </div>
  );
}
