import { listAliases, saveAliases } from "@messaging-agent/core";
import { core } from "@/lib/core";

/**
 * The addresses this operator's mail actually comes from (spec 10a). The list
 * starts empty and the operator fills it in: an address is the one thing here
 * that cannot be guessed, and a wrong guess quietly mis-files their own mail.
 */
export function aliasesForForm(): string[] {
  const { db } = core();
  return listAliases(db).map((a) => a.address);
}
