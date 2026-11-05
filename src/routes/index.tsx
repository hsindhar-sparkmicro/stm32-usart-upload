import { createFileRoute } from "@tanstack/react-router";
import { Uploader } from "@/components/uploader";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <main className="min-h-screen overflow-x-hidden bg-bg text-fg">
      <Uploader />
    </main>
  );
}
