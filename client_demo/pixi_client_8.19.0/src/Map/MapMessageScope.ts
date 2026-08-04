import { ClientMessageScope } from "../Generated/SDK/Core/Net/ClientMessageDispatcher";
import type { MapWorld } from "./MapWorld";

export const MapMessageScope = new ClientMessageScope<MapWorld>("PixiMap");
