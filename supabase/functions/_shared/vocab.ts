// Accounts and categories are derivative of the ledger now — nothing is
// pre-seeded, so there's no fixed vocabulary to keep here anymore. This
// file just keeps the one parsing helper still used by ledger.ts/writeRegistry.ts.

export function categoryNameParts(categoryPath: string): { parent: string; child: string | null } {
  const [parent, child] = categoryPath.split('>').map((s) => s.trim());
  return { parent, child: child ?? null };
}
