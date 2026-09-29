import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { MONGODB_CODEC_SCRIPT } from "../mongodb-codec.js";

class ObjectID {
  constructor(hex) { this.hex = hex.toLowerCase(); this._bsontype = "ObjectID"; }
  toHexString() { return this.hex; }
  toJSON() { return this.hex; }
}

class Int32 {
  constructor(value) { this.value = value; this._bsontype = "Int32"; }
  valueOf() { return this.value; }
}

class Double {
  constructor(value) { this.value = value; this._bsontype = "Double"; }
  valueOf() { return this.value; }
}

class Binary {
  constructor(buffer, subtype) { this.buffer = Buffer.from(buffer); this.position = this.buffer.length; this.sub_type = subtype; this._bsontype = "Binary"; }
}

class Timestamp {
  constructor(low, high) { this.low = low; this.high = high; this._bsontype = "Timestamp"; }
  getLowBitsUnsigned() { return this.low >>> 0; }
  getHighBitsUnsigned() { return this.high >>> 0; }
}

class MinKey { constructor() { this._bsontype = "MinKey"; } }
class MaxKey { constructor() { this._bsontype = "MaxKey"; } }

function codec(bson, driver = {}) {
  return vm.runInNewContext(MONGODB_CODEC_SCRIPT + "\n({ decode: __decode, encode: __encode })", {
    __bson: bson, __driverPath: "driver", require: () => driver, Buffer,
  });
}

test("legacy codec converts nested ObjectIds using BSON or MongoDB driver aliases", () => {
  const id = { $oid: "507f1f77bcf86cd799439011" };
  for (const [bson, driver] of [[{ ObjectID }, {}], [{ ObjectId: ObjectID }, {}], [null, { ObjectID }], [{}, { ObjectId: ObjectID }]]) {
    const { decode, encode } = codec(bson, driver);
    const input = { _id: { $in: [id] }, $set: { refs: [id], text: id.$oid }, createdAt: { $date: "2026-09-20T00:00:00.000Z" } };
    const decoded = decode(input);
    assert.ok(decoded._id.$in[0] instanceof ObjectID);
    assert.ok(decoded.$set.refs[0] instanceof ObjectID);
    assert.equal(decoded.$set.text, id.$oid);
    assert.equal(decoded.createdAt.toISOString(), input.createdAt.$date);
    assert.deepEqual(JSON.parse(JSON.stringify(encode(decoded))), input);
    decoded._id.$in[0]._bsontype = "ObjectId";
    assert.deepEqual(JSON.parse(JSON.stringify(encode(decoded))), input);
  }
});

test("legacy codec rejects malformed ObjectIds and unsupported BSON without silently losing types", () => {
  const { decode, encode } = codec({ ObjectID });
  for (const value of [{ $oid: "bad" }, { $oid: "507f1f77bcf86cd799439011", extra: 1 }, { $oid: 1 }, { $binary: {} }]) {
    assert.throws(() => decode(value), { code: "MONGODB_BSON_UNSUPPORTED" });
  }
  assert.throws(() => codec(null).decode({ $oid: "507f1f77bcf86cd799439011" }), { code: "MONGODB_BSON_UNSUPPORTED" });
  assert.throws(() => encode({ _bsontype: "Timestamp" }), { code: "MONGODB_BSON_UNSUPPORTED" });
  assert.doesNotMatch(MONGODB_CODEC_SCRIPT, /\?\.|\?\?/);
});

test("legacy codec round-trips numeric widths, binary, timestamps, and BSON key sentinels", () => {
  const bson = { ObjectID, Int32, Double, Binary, Timestamp, MinKey, MaxKey };
  const { decode, encode } = codec(bson);
  const input = {
    count: { $numberInt: "2147483647" },
    ratio: { $numberDouble: "1.2345678901234567" },
    payload: { $binary: { base64: "AP9B", subType: "80" } },
    stamp: { $timestamp: { t: 4294967295, i: 17 } },
    lowest: { $minKey: 1 },
    highest: { $maxKey: 1 },
  };
  const decoded = decode(input);
  assert.equal(decoded.count._bsontype, "Int32");
  assert.equal(decoded.ratio._bsontype, "Double");
  assert.equal(decoded.payload._bsontype, "Binary");
  assert.equal(decoded.stamp._bsontype, "Timestamp");
  assert.equal(decoded.lowest._bsontype, "MinKey");
  assert.equal(decoded.highest._bsontype, "MaxKey");
  assert.deepEqual(JSON.parse(JSON.stringify(encode(decoded))), input);
});

test("legacy codec rejects malformed binary, timestamp, and out-of-range Int32 values", () => {
  const { decode } = codec({ Binary, Timestamp, Int32 });
  for (const value of [
    { $numberInt: "2147483648" },
    { $binary: { base64: "***", subType: "00" } },
    { $binary: { base64: "AA==", subType: "xyz" } },
    { $timestamp: { t: -1, i: 0 } },
  ]) {
    assert.throws(() => decode(value), { code: "MONGODB_BSON_UNSUPPORTED" });
  }
});

test("codec continues to use native EJSON when available", () => {
  const calls = [];
  const { decode, encode } = codec({ EJSON: {
    parse(s) { calls.push("parse"); return JSON.parse(s); },
    stringify(v) { calls.push("stringify"); return JSON.stringify(v); },
  } });
  assert.equal(decode(undefined), undefined);
  assert.equal(encode(decode({ value: 3 })).value, 3);
  assert.deepEqual(calls, ["parse", "stringify"]);
});
