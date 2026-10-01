import Header from "@/components/Header";
import Chunker from "@/components/Chunker";
import LLMQuery from "@/components/LLMQuery";

export default function Home() {
  return (
    <div className="min-h-screen bg-[#0D1013]">
      <Header />
      <main className="mx-auto max-w-6xl px-5 py-6 sm:px-8 sm:py-8">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Chunker />
          <LLMQuery />
        </div>
      </main>
    </div>
  );
}
