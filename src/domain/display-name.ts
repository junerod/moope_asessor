import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { memories, users } from "@/db/schema";

/** “meu nome pode ser sempre JUNE” muda o nome do cadastro, não vira lembrança do dia. */
export function parseDisplayNameChange(text: string): string | null {
  const raw = String(text || "").trim();
  if (!raw || raw.length > 160) return null;
  const match = raw.match(
    /(?:meu nome (?:pode ser|é|e|sera|será)|pode me chamar de|me chama de|me chame de|quero ser chamado de|quero que me chame de)\s+(?:sempre\s+)?([A-Za-zÀ-ÿ]{2,30})\b/i
  );
  const name = match?.[1]?.trim();
  if (!name) return null;
  if (/^(sempre|juneval|assim|isso)$/i.test(name)) return null;
  return name.slice(0, 40);
}

export async function applyDisplayNameChange(
  db: Db,
  input: { userId: string; workspaceId: string; name: string }
): Promise<string> {
  const shown = input.name.slice(0, 40);
  const user = await db.query.users.findFirst({
    where: eq(users.id, input.userId),
  });
  await db
    .update(users)
    .set({
      name: shown,
      fullName: shown,
      updatedAt: new Date(),
    })
    .where(eq(users.id, input.userId));

  await db
    .update(memories)
    .set({ status: "archived", deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(memories.workspaceId, input.workspaceId),
        eq(memories.status, "active"),
        isNull(memories.deletedAt),
        sql`${memories.content} ~* 'meu nome|pode ser sempre|me chama de|me chame de'`
      )
    );

  const previous = user?.name ? ` Antes era ${user.name}.` : "";
  return `Pode deixar. Daqui pra frente te chamo de *${shown}*.${previous} Isso não fica na lista do dia.`;
}
