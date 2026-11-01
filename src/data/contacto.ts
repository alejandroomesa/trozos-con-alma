// Añade el número en formato internacional, solo con dígitos (por ejemplo: 34600111222).
export const whatsappNumber = "34626063394";

export function enlaceWhatsApp(mensaje: string) {
  if (!whatsappNumber) return undefined;

  return `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(mensaje)}`;
}
