export interface Coord {
  x: number;
  y: number;
}

export interface Battlesnake {
  id: string;
  name: string;
  health: number;
  body: Coord[];
  head: Coord;
  length: number;
}

export interface Board {
  height: number;
  width: number;
  food: Coord[];
  snakes: Battlesnake[];
  hazards: Coord[];
}

export interface GameState {
  game: { id: string; timeout: number };
  turn: number;
  board: Board;
  you: Battlesnake;
}

export type Move = "up" | "down" | "left" | "right";
