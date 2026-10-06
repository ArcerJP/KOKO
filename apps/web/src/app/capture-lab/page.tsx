import { CaptureLab } from "../../components/capture-lab";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "端末内の撮影・トリム検証" };
export default function CaptureLabPage() {
  return <CaptureLab />;
}
