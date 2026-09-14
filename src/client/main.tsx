import "./index.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { extractInitialPage } from "./bootstrap";

const initialPage = extractInitialPage(document, new URL(location.href));
const mount = document.querySelector<HTMLDivElement>("#app");
if (mount === null) throw new Error("Missing application root");
createRoot(mount).render(<App initialPage={initialPage} />);
