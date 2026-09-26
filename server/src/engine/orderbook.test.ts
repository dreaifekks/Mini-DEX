// 撮合引擎单元测试（vitest）。每个 case 对应一条撮合规则，先看测试再看实现更好懂。
import { describe, it, expect } from "vitest";
import { OrderBook, type Side, type OrderType } from "./orderbook.js";
import { parseFixed as F } from "../fixed.js";

let n = 0;
function order(owner: string, side: Side, type: OrderType, price: string, qty: string) {
  return { id: `o${++n}`, owner, side, type, price: type === "market" ? 0n : F(price), qty: F(qty) };
}
const limit = (owner: string, side: Side, price: string, qty: string) => order(owner, side, "limit", price, qty);
const market = (owner: string, side: Side, qty: string) => order(owner, side, "market", "0", qty);

describe("OrderBook", () => {
  it("空簿：limit 单直接挂上", () => {
    const ob = new OrderBook();
    const r = ob.submit(limit("alice", "sell", "100", "1"));
    expect(r.fills).toHaveLength(0);
    expect(r.resting?.remaining).toBe(F("1"));
    expect(ob.bestAsk()).toBe(F("100"));
    expect(ob.bestBid()).toBeNull();
  });

  it("价格交叉：按 maker 价成交", () => {
    const ob = new OrderBook();
    ob.submit(limit("alice", "sell", "100", "1"));
    const r = ob.submit(limit("bob", "buy", "105", "1")); // bob 愿出 105，但按 alice 的 100 成交
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.price).toBe(F("100"));
    expect(r.fills[0]!.qty).toBe(F("1"));
    expect(r.fills[0]!.maker).toBe("alice");
    expect(r.fills[0]!.taker).toBe("bob");
    expect(r.resting).toBeNull();
    expect(ob.bestAsk()).toBeNull();
  });

  it("部分成交：剩余部分挂单", () => {
    const ob = new OrderBook();
    ob.submit(limit("alice", "sell", "100", "1"));
    const r = ob.submit(limit("bob", "buy", "100", "3"));
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.qty).toBe(F("1"));
    expect(r.resting?.remaining).toBe(F("2"));
    expect(ob.bestBid()).toBe(F("100"));
    expect(ob.snapshot(5).bids).toEqual([[F("100"), F("2")]]);
  });

  it("价格优先：更优价格先成交", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "sell", "102", "1"));
    ob.submit(limit("b", "sell", "100", "1")); // 更便宜，后挂但先成交
    const r = ob.submit(market("t", "buy", "1"));
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.maker).toBe("b");
    expect(r.fills[0]!.price).toBe(F("100"));
  });

  it("时间优先：同价 FIFO", () => {
    const ob = new OrderBook();
    const first = ob.submit(limit("a", "sell", "100", "1")).resting!;
    ob.submit(limit("b", "sell", "100", "1"));
    const r = ob.submit(market("t", "buy", "1"));
    expect(r.fills[0]!.makerOrderId).toBe(first.id);
    expect(r.fills[0]!.maker).toBe("a");
  });

  it("时间优先：同价同时间戳也按提交顺序，先到的吃完才轮到后到的", () => {
    const ob = new OrderBook();
    const ts = 1_700_000_000_000; // 三笔挂单时间戳完全相同，只能靠提交序号 seq 分先后
    const a = ob.submit({ ...limit("a", "sell", "100", "1"), ts }).resting!;
    const b = ob.submit({ ...limit("b", "sell", "100", "1"), ts }).resting!;
    const c = ob.submit({ ...limit("c", "sell", "100", "1"), ts }).resting!;
    const r = ob.submit(market("t", "buy", "1.5"));
    expect(r.fills.map((f) => [f.makerOrderId, f.qty])).toEqual([
      [a.id, F("1")],   // a 先到，先被吃完
      [b.id, F("0.5")], // 然后才轮到 b，只吃掉一半
    ]);
    expect(ob.get(a.id)).toBeUndefined();
    expect(ob.get(b.id)?.remaining).toBe(F("0.5"));
    expect(ob.get(c.id)?.remaining).toBe(F("1")); // c 还没轮到，原样不动
    expect(ob.snapshot(5).asks).toEqual([[F("100"), F("1.5")]]);
  });

  describe("拒绝 self-trade（自成交）", () => {
    it("同档里跳过自己的单，吃后面别人的单；自己的单原样留在簿上", () => {
      const ob = new OrderBook();
      const mine = ob.submit(limit("alice", "sell", "100", "1")).resting!; // alice 自己先挂的卖单
      ob.submit(limit("bob", "sell", "100", "1"));                        // bob 同价后挂
      const r = ob.submit(limit("alice", "buy", "100", "1"));             // alice 再买：不能吃到自己
      expect(r.fills).toHaveLength(1);
      expect(r.fills[0]!.maker).toBe("bob");
      expect(r.fills[0]!.taker).toBe("alice");
      expect(r.resting).toBeNull();
      expect(ob.get(mine.id)?.remaining).toBe(F("1")); // 自己的挂单没被撤、没被减
      expect(ob.snapshot(5).asks).toEqual([[F("100"), F("1")]]);
    });

    it("整档只有自己的单时，继续吃仍满足限价的下一档", () => {
      const ob = new OrderBook();
      const mine = ob.submit(limit("alice", "sell", "100", "1")).resting!; // 最优价只有自己
      ob.submit(limit("bob", "sell", "101", "1"));                        // 下一档是别人
      const r = ob.submit(limit("alice", "buy", "105", "1"));
      expect(r.fills).toHaveLength(1);
      expect(r.fills[0]!.maker).toBe("bob");
      expect(r.fills[0]!.price).toBe(F("101")); // 跳过自己的 100，按 bob 的 101 成交
      expect(ob.get(mine.id)?.remaining).toBe(F("1"));
      expect(ob.bestAsk()).toBe(F("100"));      // 自己的单仍是卖一
    });

    it("对手盘全是自己：limit 单不成交只挂单，market 单不成交也不挂", () => {
      const ob = new OrderBook();
      const mine = ob.submit(limit("alice", "sell", "100", "2")).resting!;

      const lim = ob.submit(limit("alice", "buy", "100", "1"));
      expect(lim.fills).toHaveLength(0);
      expect(lim.resting?.remaining).toBe(F("1")); // 买单挂到 bids，与自己的卖单并存
      expect(ob.bestBid()).toBe(F("100"));

      const mkt = ob.submit(market("alice", "sell", "1")); // 自己的市价卖单也不能吃自己的买单
      expect(mkt.fills).toHaveLength(0);
      expect(mkt.resting).toBeNull();

      expect(ob.get(mine.id)?.remaining).toBe(F("2"));
      expect(ob.snapshot(5)).toEqual({ bids: [[F("100"), F("1")]], asks: [[F("100"), F("2")]] });
    });
  });

  it("market 买单：吃穿多个档位", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "sell", "100", "1"));
    ob.submit(limit("b", "sell", "101", "1"));
    ob.submit(limit("c", "sell", "102", "5"));
    const r = ob.submit(market("t", "buy", "2.5"));
    expect(r.fills.map((f) => [f.price, f.qty])).toEqual([
      [F("100"), F("1")],
      [F("101"), F("1")],
      [F("102"), F("0.5")],
    ]);
    expect(r.resting).toBeNull();
    expect(ob.snapshot(5).asks).toEqual([[F("102"), F("4.5")]]);
  });

  it("market 单遇到空簿：不成交也不挂单", () => {
    const ob = new OrderBook();
    const r = ob.submit(market("t", "buy", "1"));
    expect(r.fills).toHaveLength(0);
    expect(r.resting).toBeNull();
    expect(ob.snapshot(5)).toEqual({ bids: [], asks: [] });
  });

  it("market 单流动性不足：吃完就停", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "sell", "100", "1"));
    const r = ob.submit(market("t", "buy", "5"));
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.qty).toBe(F("1"));
    expect(r.resting).toBeNull();
    expect(ob.bestAsk()).toBeNull();
  });

  it("撤单：从簿和快照里移除", () => {
    const ob = new OrderBook();
    const o = ob.submit(limit("a", "sell", "100", "1")).resting!;
    expect(ob.cancel(o.id, "someone-else")).toBeNull(); // 不能撤别人的
    const cancelled = ob.cancel(o.id, "a");
    expect(cancelled?.id).toBe(o.id);
    expect(ob.cancel(o.id, "a")).toBeNull();             // 重复撤返回 null
    expect(ob.bestAsk()).toBeNull();
    expect(ob.snapshot(5).asks).toEqual([]);
    expect(ob.ordersOf("a")).toEqual([]);
  });

  it("快照：同价订单数量合并，且按深度截断", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "buy", "99", "1"));
    ob.submit(limit("b", "buy", "99", "2"));
    ob.submit(limit("c", "buy", "98", "1"));
    ob.submit(limit("d", "buy", "97", "1"));
    const s = ob.snapshot(2);
    expect(s.bids).toEqual([
      [F("99"), F("3")],
      [F("98"), F("1")],
    ]);
    expect(ob.bestBid()).toBe(F("99"));
  });

  it("limit 单吃穿多档后剩余挂单", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "sell", "100", "1"));
    ob.submit(limit("b", "sell", "101", "1"));
    ob.submit(limit("c", "sell", "110", "1")); // 超出 105，不该被吃
    const r = ob.submit(limit("t", "buy", "105", "3"));
    expect(r.fills.map((f) => f.price)).toEqual([F("100"), F("101")]);
    expect(r.resting?.remaining).toBe(F("1"));
    expect(ob.bestBid()).toBe(F("105"));
    expect(ob.bestAsk()).toBe(F("110"));
  });

  it("ordersOf：只返回该用户还在簿上的单", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "buy", "90", "1"));
    ob.submit(limit("a", "sell", "110", "1"));
    ob.submit(limit("b", "sell", "120", "1"));
    expect(ob.ordersOf("a").map((o) => o.price).sort((a, b) => (a < b ? -1 : 1))).toEqual([F("90"), F("110")]);
    expect(ob.ordersOf("b")).toHaveLength(1);
  });
});
