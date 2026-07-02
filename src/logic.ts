import { Coord, GameState, Move } from "./types";

const ALL_MOVES: Move[] = ["up", "down", "left", "right"];
const LOW_HEALTH_THRESHOLD = 50;
const AGGRO_RANGE = 6;

export function info() {
  return {
    apiversion: "1",
    author: "",
    color: "#00b4d8",
    head: "default",
    tail: "default",
  };
}

export function start(gameState: GameState) {
  console.log(`GAME START: ${gameState.game.id}`);
}

export function end(gameState: GameState) {
  console.log(`GAME OVER: ${gameState.game.id}`);
}

function moveTo(coord: Coord, move: Move): Coord {
  switch (move) {
    case "up":
      return { x: coord.x, y: coord.y + 1 };
    case "down":
      return { x: coord.x, y: coord.y - 1 };
    case "left":
      return { x: coord.x - 1, y: coord.y };
    case "right":
      return { x: coord.x + 1, y: coord.y };
  }
}

function coordKey(coord: Coord): string {
  return `${coord.x},${coord.y}`;
}

function isOutOfBounds(coord: Coord, gameState: GameState): boolean {
  return (
    coord.x < 0 ||
    coord.y < 0 ||
    coord.x >= gameState.board.width ||
    coord.y >= gameState.board.height
  );
}

// Body segments are occupied for the next turn, except a tail that is about
// to move away - unless the snake just ate (duplicate tail segment), in
// which case it stays put for one more turn.
function buildOccupiedCells(gameState: GameState): Set<string> {
  const occupied = new Set<string>();
  for (const snake of gameState.board.snakes) {
    const body = snake.body;
    const justAte =
      body.length >= 2 &&
      body[body.length - 1].x === body[body.length - 2].x &&
      body[body.length - 1].y === body[body.length - 2].y;

    body.forEach((segment, index) => {
      const isTail = index === body.length - 1;
      if (isTail && !justAte) return;
      occupied.add(coordKey(segment));
    });
  }
  return occupied;
}

// Cells an equal-or-larger enemy could move its head into next turn - a
// head-on collision there kills us (or is a tie), so treat them as risky.
function buildRiskyCells(gameState: GameState): Set<string> {
  const risky = new Set<string>();
  for (const snake of gameState.board.snakes) {
    if (snake.id === gameState.you.id) continue;
    if (snake.length < gameState.you.length) continue;

    for (const dir of ALL_MOVES) {
      const next = moveTo(snake.head, dir);
      if (!isOutOfBounds(next, gameState)) {
        risky.add(coordKey(next));
      }
    }
  }
  return risky;
}

// Flood fill from a candidate cell to estimate how much open space it leads
// to, so we don't wander into a pocket we can't get back out of.
function floodFillSize(
  start: Coord,
  gameState: GameState,
  occupied: Set<string>,
  limit: number
): number {
  const visited = new Set<string>([coordKey(start)]);
  const queue: Coord[] = [start];
  let count = 0;

  while (queue.length > 0 && count < limit) {
    const current = queue.shift()!;
    count++;

    for (const dir of ALL_MOVES) {
      const next = moveTo(current, dir);
      const key = coordKey(next);
      if (visited.has(key) || isOutOfBounds(next, gameState) || occupied.has(key)) {
        continue;
      }
      visited.add(key);
      queue.push(next);
    }
  }

  return count;
}

function distanceToNearestFood(coord: Coord, gameState: GameState): number {
  if (gameState.board.food.length === 0) return Infinity;
  return Math.min(
    ...gameState.board.food.map((food) => Math.abs(food.x - coord.x) + Math.abs(food.y - coord.y))
  );
}

function buildHazardCells(gameState: GameState): Set<string> {
  return new Set(gameState.board.hazards.map(coordKey));
}

// Chasing a strictly smaller snake threatens a head-to-head we'd win, which
// can force it into a mistake or a kill - but only worth it nearby, so it
// doesn't pull us away from food or safety for a snake across the board.
function distanceToNearestSmallerEnemy(coord: Coord, gameState: GameState): number {
  const smaller = gameState.board.snakes.filter(
    (snake) => snake.id !== gameState.you.id && snake.length < gameState.you.length
  );
  if (smaller.length === 0) return Infinity;
  return Math.min(
    ...smaller.map((snake) => Math.abs(snake.head.x - coord.x) + Math.abs(snake.head.y - coord.y))
  );
}

export function move(gameState: GameState): { move: Move } {
  const occupied = buildOccupiedCells(gameState);
  const risky = buildRiskyCells(gameState);
  const hazards = buildHazardCells(gameState);

  let candidates = ALL_MOVES.filter((candidate) => {
    const next = moveTo(gameState.you.head, candidate);
    return !isOutOfBounds(next, gameState) && !occupied.has(coordKey(next));
  });

  if (candidates.length === 0) {
    console.log(`MOVE ${gameState.turn}: No safe moves left, moving down`);
    return { move: "down" };
  }

  // Prefer moves that don't risk a losing head-to-head, unless that's all we have.
  const nonRisky = candidates.filter(
    (candidate) => !risky.has(coordKey(moveTo(gameState.you.head, candidate)))
  );
  if (nonRisky.length > 0) candidates = nonRisky;

  // Hazard cells cost extra health rather than killing outright, so avoid them
  // only when a non-hazardous option is still available.
  const nonHazard = candidates.filter(
    (candidate) => !hazards.has(coordKey(moveTo(gameState.you.head, candidate)))
  );
  if (nonHazard.length > 0) candidates = nonHazard;

  const boardSize = gameState.board.width * gameState.board.height;
  const scored = candidates.map((candidate) => {
    const next = moveTo(gameState.you.head, candidate);
    return {
      move: candidate,
      space: floodFillSize(next, gameState, occupied, boardSize),
      foodDistance: distanceToNearestFood(next, gameState),
      enemyDistance: distanceToNearestSmallerEnemy(next, gameState),
    };
  });

  // Discard moves that trap us in a space smaller than our own body, if a
  // roomier option exists.
  const roomy = scored.filter((s) => s.space >= gameState.you.length);
  const options = roomy.length > 0 ? roomy : scored;

  const lowHealth = gameState.you.health <= LOW_HEALTH_THRESHOLD;
  const aggroActive =
    !lowHealth && distanceToNearestSmallerEnemy(gameState.you.head, gameState) <= AGGRO_RANGE;

  options.sort((a, b) => {
    if (lowHealth && a.foodDistance !== b.foodDistance) {
      return a.foodDistance - b.foodDistance;
    }
    if (b.space !== a.space) return b.space - a.space;
    if (aggroActive && a.enemyDistance !== b.enemyDistance) {
      return a.enemyDistance - b.enemyDistance;
    }
    return a.foodDistance - b.foodDistance;
  });

  const chosen = options[0].move;
  console.log(`MOVE ${gameState.turn}: ${chosen}`);
  return { move: chosen };
}
