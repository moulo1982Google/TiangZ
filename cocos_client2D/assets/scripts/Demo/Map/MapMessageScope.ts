import { ClientMessageScope } from "../../Core/Net/ClientMessageDispatcher";
import type { MapEntityManager } from "./MapEntityManager";

export const MapMessageScope = new ClientMessageScope<MapEntityManager>("Map");
