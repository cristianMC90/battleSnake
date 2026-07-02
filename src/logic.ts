import { Coord, GameState, Move } from "./types";

const ALL_MOVES: Move[] = ["up", "down", "left", "right"];
const LOW_HEALTH_THRESHOLD = 50;
const AGGRO_RANGE = 6;
const THREAT_LOOKAHEAD_RANGE = 4;

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

// Array.sort is stable, so without this, tied scores would always resolve
// to the same ALL_MOVES order (e.g. always "up") - a pattern an opponent
// could learn. Shuffling first makes ties resolve randomly instead.
function shuffled<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function coordKey(coord: Coord): string {
  return `${coord.x},${coord.y}`;
}

function parseCoordKey(key: string): Coord {
  const [x, y] = key.split(",").map(Number);
  return { x, y };
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

// The nearest equal-or-larger enemy is the one worth simulating a move ahead
// for - anything farther away can't reach us in time to matter for this turn.
function findNearestThreat(gameState: GameState): Coord & { length: number } | null {
  let nearest: (Coord & { length: number }) | null = null;
  let nearestDistance = Infinity;

  for (const snake of gameState.board.snakes) {
    if (snake.id === gameState.you.id) continue;
    if (snake.length < gameState.you.length) continue;

    const distance = Math.abs(snake.head.x - gameState.you.head.x) + Math.abs(snake.head.y - gameState.you.head.y);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = { ...snake.head, length: snake.length };
    }
  }

  return nearestDistance <= THREAT_LOOKAHEAD_RANGE ? nearest : null;
}

// A move can look safe this turn yet still walk us into a corner: the threat
// takes its own best shot next turn, and only then do we find out how much
// room is left. This simulates every move the threat could make and keeps
// the worst resulting space - a losing head-to-head counts as zero room.
function worstCaseSpaceAfterThreat(
  ourNextHead: Coord,
  threat: Coord,
  gameState: GameState,
  occupied: Set<string>,
  boardSize: number
): number {
  const threatMoves = ALL_MOVES.map((dir) => moveTo(threat, dir)).filter(
    (pos) => !isOutOfBounds(pos, gameState) && !occupied.has(coordKey(pos))
  );

  if (threatMoves.length === 0) {
    return floodFillSize(ourNextHead, gameState, occupied, boardSize);
  }

  let worst = Infinity;
  for (const threatNext of threatMoves) {
    if (coordKey(threatNext) === coordKey(ourNextHead)) {
      worst = 0;
      continue;
    }
    const occupiedAfterThreatMove = new Set(occupied);
    occupiedAfterThreatMove.add(coordKey(threatNext));
    worst = Math.min(worst, floodFillSize(ourNextHead, gameState, occupiedAfterThreatMove, boardSize));
  }
  return worst;
}

// Plain flood-fill only tells us whether space is reachable, not whether an
// enemy would get there first and cut us off. This races every snake's head
// outward simultaneously (multi-source BFS) and counts cells we'd reach
// strictly before any enemy - our actual contested territory, not just
// theoretically empty space.
function computeControlledSpace(
  candidateHead: Coord,
  gameState: GameState,
  occupied: Set<string>
): number {
  const owner = new Map<string, string>();
  let frontier: Array<{ key: string; owner: string }> = [];

  const youKey = coordKey(candidateHead);
  owner.set(youKey, "you");
  frontier.push({ key: youKey, owner: "you" });

  for (const snake of gameState.board.snakes) {
    if (snake.id === gameState.you.id) continue;
    const key = coordKey(snake.head);
    if (owner.has(key)) continue;
    owner.set(key, snake.id);
    frontier.push({ key, owner: snake.id });
  }

  while (frontier.length > 0) {
    const claims = new Map<string, Set<string>>();
    for (const { key, owner: ownerId } of frontier) {
      for (const dir of ALL_MOVES) {
        const next = moveTo(parseCoordKey(key), dir);
        const nextKey = coordKey(next);
        if (owner.has(nextKey) || isOutOfBounds(next, gameState) || occupied.has(nextKey)) {
          continue;
        }
        if (!claims.has(nextKey)) claims.set(nextKey, new Set());
        claims.get(nextKey)!.add(ownerId);
      }
    }

    frontier = [];
    for (const [key, owners] of claims) {
      // Two snakes reaching a cell in the same number of moves means neither
      // gets there uncontested - leave it unclaimed rather than guess.
      if (owners.size !== 1) continue;
      const ownerId = [...owners][0];
      owner.set(key, ownerId);
      frontier.push({ key, owner: ownerId });
    }
  }

  let count = 0;
  for (const ownerId of owner.values()) {
    if (ownerId === "you") count++;
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

// In Royale, the hazard zone keeps expanding until only a small safe area is
// left - if every move from here is through hazard anyway, the priority
// shifts from food/territory to getting back onto safe ground as fast as
// possible, since sitting in hazard drains health well beyond normal upkeep.
function distanceToNearestSafeCell(coord: Coord, gameState: GameState, hazards: Set<string>): number {
  let nearest = Infinity;
  for (let x = 0; x < gameState.board.width; x++) {
    for (let y = 0; y < gameState.board.height; y++) {
      if (hazards.has(coordKey({ x, y }))) continue;
      const distance = Math.abs(x - coord.x) + Math.abs(y - coord.y);
      if (distance < nearest) nearest = distance;
    }
  }
  return nearest;
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

  const boardSize = gameState.board.width * gameState.board.height;
  const threat = findNearestThreat(gameState);

  // Look one move past the threat's response: a move that survives this
  // turn but leaves no real room once it reacts is still a trap, so avoid
  // it while a more robust option exists.
  if (threat) {
    const survivesThreatResponse = candidates.filter((candidate) => {
      const next = moveTo(gameState.you.head, candidate);
      return worstCaseSpaceAfterThreat(next, threat, gameState, occupied, boardSize) >= gameState.you.length;
    });
    if (survivesThreatResponse.length > 0) candidates = survivesThreatResponse;
  }

  // Hazard cells cost extra health rather than killing outright, so avoid them
  // only when a non-hazardous option is still available.
  const nonHazard = candidates.filter(
    (candidate) => !hazards.has(coordKey(moveTo(gameState.you.head, candidate)))
  );
  const forcedIntoHazard = hazards.size > 0 && nonHazard.length === 0;
  if (nonHazard.length > 0) candidates = nonHazard;

  const scored = shuffled(candidates).map((candidate) => {
    const next = moveTo(gameState.you.head, candidate);
    return {
      move: candidate,
      space: floodFillSize(next, gameState, occupied, boardSize),
      controlledSpace: computeControlledSpace(next, gameState, occupied),
      foodDistance: distanceToNearestFood(next, gameState),
      enemyDistance: distanceToNearestSmallerEnemy(next, gameState),
      safeCellDistance: forcedIntoHazard ? distanceToNearestSafeCell(next, gameState, hazards) : 0,
    };
  });

  // Discard moves that trap us in a space smaller than our own body, if a
  // roomier option exists. This is about raw reachable space (a dead end is
  // fatal even if uncontested), unlike the controlled-space score below.
  const roomy = scored.filter((s) => s.space >= gameState.you.length);
  const options = roomy.length > 0 ? roomy : scored;

  const lowHealth = gameState.you.health <= LOW_HEALTH_THRESHOLD;
  const aggroActive =
    !lowHealth && distanceToNearestSmallerEnemy(gameState.you.head, gameState) <= AGGRO_RANGE;

  options.sort((a, b) => {
    if (forcedIntoHazard && a.safeCellDistance !== b.safeCellDistance) {
      return a.safeCellDistance - b.safeCellDistance;
    }
    if (lowHealth && a.foodDistance !== b.foodDistance) {
      return a.foodDistance - b.foodDistance;
    }
    if (b.controlledSpace !== a.controlledSpace) return b.controlledSpace - a.controlledSpace;
    if (aggroActive && a.enemyDistance !== b.enemyDistance) {
      return a.enemyDistance - b.enemyDistance;
    }
    return a.foodDistance - b.foodDistance;
  });

  const chosen = options[0].move;
  console.log(`MOVE ${gameState.turn}: ${chosen}`);
  return { move: chosen };
}
