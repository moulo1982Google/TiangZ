import { ClientMessageScope } from "../Generated/SDK/Core/Net/ClientMessageDispatcher";
import type { GameBootstrap3D } from "./GameBootstrap3D";

export const MapMessageScope3D = new ClientMessageScope<GameBootstrap3D>("Map3D");
