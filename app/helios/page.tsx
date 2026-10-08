import { HeliosApp } from "../HeliosApp";
import { SetupRequired } from "../SetupRequired";

export const dynamic = "force-dynamic";

export default function HeliosPage() {
  return process.env.REACTOR_API_KEY ? <HeliosApp /> : <SetupRequired />;
}
