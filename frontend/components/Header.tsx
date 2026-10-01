import { Scissors } from "lucide-react";
import BackendStatus from "./BackendStatus";

export default function Header() {
  return (
    <header className="border-b border-[#2A313A] bg-[#0D1013]">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-8">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md border border-[#2A313A] bg-[#161A1F] text-[#E3A857]">
            <Scissors size={17} />
          </div>
          <div>
            <h1 className="text-[15px] font-semibold leading-tight text-[#E7E9EC]">
              AI Text Chunker
            </h1>
            <p className="text-[13px] leading-tight text-[#8A93A0]">
              Split documents into overlapping chunks, then ask questions about them.
            </p>
          </div>
        </div>
        <BackendStatus />
      </div>
    </header>
  );
}
