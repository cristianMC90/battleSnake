import express, { Request, Response } from "express";
import { info, start, move, end } from "./logic";
import { GameState } from "./types";

const app = express();
app.use(express.json());

app.get("/", (req: Request, res: Response) => {
  res.send(info());
});

app.post("/start", (req: Request, res: Response) => {
  start(req.body as GameState);
  res.send("ok");
});

app.post("/move", (req: Request, res: Response) => {
  res.send(move(req.body as GameState));
});

app.post("/end", (req: Request, res: Response) => {
  end(req.body as GameState);
  res.send("ok");
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Battlesnake server listening on port ${PORT}`);
});
