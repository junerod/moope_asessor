export const DEV_MASTER_PHONE = "+5561996715985";

export function getDevMasterPhoneVariants(): string[] {
  const digits = DEV_MASTER_PHONE.replace(/\D/g, "");
  const variants = new Set([DEV_MASTER_PHONE]);
  if (digits.startsWith("55") && digits.length === 13) {
    variants.add(`+${digits.slice(0, 4)}${digits.slice(5)}`);
  }
  if (digits.startsWith("55") && digits.length === 12) {
    variants.add(`+${digits.slice(0, 4)}9${digits.slice(4)}`);
  }
  return [...variants];
}

export function isDevMasterPhone(phone: string): boolean {
  const digits = String(phone || "").replace(/\D/g, "");
  return getDevMasterPhoneVariants().some(
    (variant) => variant.replace(/\D/g, "") === digits
  );
}