import Link from "next/link";

const LINKS = [
  { id: "pessoal", href: "/ajuda/pessoal", label: "Pessoal" },
  { id: "locadora", href: "/ajuda/locadora", label: "Locadora" },
  { id: "facejus", href: "/ajuda/facejus", label: "Facejus" },
  { id: "crm", href: "/ajuda/crm", label: "CRM" },
] as const;

export function ContextNote({ current }: { current: (typeof LINKS)[number]["id"] }) {
  const here = LINKS.find((item) => item.id === current)!;
  const others = LINKS.filter((item) => item.id !== current);

  return (
    <p className="context-note">
      Manual de <strong>{here.label}</strong>. Os outros contextos:{" "}
      {others.map((item, index) => (
        <span key={item.id}>
          {index > 0 ? " · " : null}
          <Link href={item.href}>{item.label}</Link>
        </span>
      ))}
      .
    </p>
  );
}
