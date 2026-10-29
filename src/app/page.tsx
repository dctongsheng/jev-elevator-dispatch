import { Dashboard } from "@/components/Dashboard";
import { LanguageProvider } from "@/components/LanguageProvider";

export default function Home() {
  return <LanguageProvider><Dashboard /></LanguageProvider>;
}
