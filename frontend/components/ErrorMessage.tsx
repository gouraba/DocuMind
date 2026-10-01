import { AlertTriangle } from "lucide-react";

export default function ErrorMessage({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-md border border-[#4A2E33] bg-[#201315] px-3.5 py-3 text-sm text-[#F2C1C9]"
    >
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <p className="leading-snug">{message}</p>
    </div>
  );
}
