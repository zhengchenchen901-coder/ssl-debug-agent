// Embedded into remote helpers; keep this source compatible with older Node.js.
export const MONGODB_CODEC_SCRIPT = String.raw`
function __codecError(message) {
  const error = new Error(message);
  error.code = "MONGODB_BSON_UNSUPPORTED";
  throw error;
}

function __bsonConstructor(name) {
  const driver = require(__driverPath);
  return (__bson && (__bson[name] || (name === "ObjectId" && __bson.ObjectID))) ||
    driver[name] || (name === "ObjectId" && driver.ObjectID);
}

function __uint32(value, label) {
  var number = typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(number) || number < 0 || number > 0xffffffff) return __codecError("invalid BSON timestamp " + label);
  return number >>> 0;
}

function __int32(value, label) {
  if (typeof value !== "string" || !/^-?[0-9]+$/.test(value)) return __codecError("invalid BSON integer " + label);
  var number = Number(value);
  if (!Number.isInteger(number) || number < -2147483648 || number > 2147483647) return __codecError("BSON integer is outside the Int32 range");
  return number;
}

function __binaryBytes(value) {
  var raw = value && value.buffer;
  if (raw && typeof value.position === "number") return Buffer.from(raw.slice(0, value.position));
  if (value && typeof value.value === "function") {
    var returned = value.value(true);
    if (Buffer.isBuffer(returned)) return Buffer.from(returned);
  }
  return __codecError("configured driver returned an unsupported BSON Binary value");
}

function __fallbackDecode(value) {
  if (Array.isArray(value)) return value.map(__fallbackDecode);
  if (!value || typeof value !== "object") return value;
  const keys = Object.keys(value);
  if (Object.prototype.hasOwnProperty.call(value, "$oid")) {
    if (keys.length !== 1 || typeof value.$oid !== "string" || !/^[a-fA-F0-9]{24}$/.test(value.$oid)) {
      return __codecError("ObjectId requires exactly one $oid containing 24 hexadecimal characters");
    }
    const ObjectId = __bsonConstructor("ObjectId");
    if (typeof ObjectId !== "function") return __codecError("configured MongoDB/BSON driver has no ObjectId constructor");
    return new ObjectId(value.$oid);
  }
  if (keys.length === 1 && keys[0] === "$date") {
    const raw = value.$date;
    const date = new Date(raw && typeof raw === "object" ? Number(raw.$numberLong) : raw);
    if (!Number.isFinite(date.getTime())) return __codecError("invalid BSON date");
    return date;
  }
  for (const pair of [["$numberLong", "Long"], ["$numberDecimal", "Decimal128"]]) {
    if (keys.length === 1 && keys[0] === pair[0]) {
      const Type = __bsonConstructor(pair[1]);
      if (!Type || typeof Type.fromString !== "function") return __codecError("configured driver cannot decode " + pair[0]);
      return Type.fromString(value[pair[0]]);
    }
  }
  if (keys.length === 1 && keys[0] === "$numberInt") {
    var Int32 = __bsonConstructor("Int32");
    var int32Value = __int32(value.$numberInt, "$numberInt");
    if (!Int32) return __codecError("configured driver cannot decode $numberInt");
    return typeof Int32.fromString === "function" ? Int32.fromString(String(int32Value)) : new Int32(int32Value);
  }
  if (keys.length === 1 && keys[0] === "$numberDouble") {
    var Double = __bsonConstructor("Double");
    var doubleText = value.$numberDouble;
    if (typeof doubleText !== "string" || !/^(?:NaN|Infinity|-Infinity|[-+]?(?:[0-9]+[.]?[0-9]*|[.][0-9]+)(?:[eE][-+]?[0-9]+)?)$/.test(doubleText)) {
      return __codecError("invalid BSON double");
    }
    if (!Double) return __codecError("configured driver cannot decode $numberDouble");
    return typeof Double.fromString === "function" ? Double.fromString(doubleText) : new Double(Number(doubleText));
  }
  if (keys.length === 1 && keys[0] === "$binary") {
    var binary = value.$binary;
    if (!binary || typeof binary !== "object" || Array.isArray(binary) || Object.keys(binary).length !== 2 ||
        typeof binary.base64 !== "string" || typeof binary.subType !== "string" || !/^[a-fA-F0-9]{2}$/.test(binary.subType)) {
      return __codecError("invalid canonical BSON binary");
    }
    var decodedBytes = Buffer.from(binary.base64, "base64");
    if (decodedBytes.toString("base64").replace(/=+$/, "") !== binary.base64.replace(/=+$/, "")) return __codecError("invalid BSON binary base64");
    var Binary = __bsonConstructor("Binary");
    if (!Binary) return __codecError("configured driver cannot decode $binary");
    return new Binary(decodedBytes, parseInt(binary.subType, 16));
  }
  if (keys.length === 1 && keys[0] === "$timestamp") {
    var timestamp = value.$timestamp;
    if (!timestamp || typeof timestamp !== "object" || Array.isArray(timestamp) || Object.keys(timestamp).some(function (key) { return key !== "t" && key !== "i"; }) ||
        !Object.prototype.hasOwnProperty.call(timestamp, "t") || !Object.prototype.hasOwnProperty.call(timestamp, "i")) {
      return __codecError("invalid BSON timestamp");
    }
    var Timestamp = __bsonConstructor("Timestamp");
    var timestampSeconds = __uint32(timestamp.t, "seconds");
    var timestampIncrement = __uint32(timestamp.i, "increment");
    if (!Timestamp) return __codecError("configured driver cannot decode $timestamp");
    if (typeof Timestamp.fromBits === "function") return Timestamp.fromBits(timestampIncrement | 0, timestampSeconds | 0);
    return new Timestamp(timestampIncrement | 0, timestampSeconds | 0);
  }
  if (keys.length === 1 && (keys[0] === "$minKey" || keys[0] === "$maxKey")) {
    if (value[keys[0]] !== 1) return __codecError("invalid " + keys[0]);
    var KeyType = __bsonConstructor(keys[0] === "$minKey" ? "MinKey" : "MaxKey");
    if (!KeyType) return __codecError("configured driver cannot decode " + keys[0]);
    return new KeyType();
  }
  const result = {};
  for (const key of keys) {
    if (["$date", "$numberLong", "$numberDecimal", "$numberInt", "$numberDouble", "$binary", "$regularExpression", "$timestamp", "$minKey", "$maxKey", "$undefined", "$symbol", "$code", "$dbPointer"].indexOf(key) !== -1) {
      return __codecError("configured driver requires EJSON.parse for " + key);
    }
    Object.defineProperty(result, key, { value: __fallbackDecode(value[key]), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function __fallbackEncode(value) {
  if (Array.isArray(value)) return value.map(__fallbackEncode);
  if (!value || typeof value !== "object") return value;
  if ((value._bsontype === "ObjectID" || value._bsontype === "ObjectId") && typeof value.toHexString === "function") {
    return { $oid: value.toHexString() };
  }
  if (Object.prototype.toString.call(value) === "[object Date]") return { $date: value.toISOString() };
  if (value._bsontype === "Long") return { $numberLong: value.toString() };
  if (value._bsontype === "Decimal128") return { $numberDecimal: value.toString() };
  if (value._bsontype === "Int32") return { $numberInt: String(typeof value.value === "number" ? value.value : value.valueOf()) };
  if (value._bsontype === "Double") return { $numberDouble: String(typeof value.value === "number" ? value.value : value.valueOf()) };
  if (value._bsontype === "Binary") {
    var binaryBytes = __binaryBytes(value);
    var subtype = typeof value.sub_type === "number" ? value.sub_type : value._subtype;
    if (!Number.isInteger(subtype) || subtype < 0 || subtype > 255) return __codecError("configured driver returned an invalid BSON Binary subtype");
    return { $binary: { base64: binaryBytes.toString("base64"), subType: ("0" + subtype.toString(16)).slice(-2) } };
  }
  if (value._bsontype === "Timestamp") {
    if (typeof value.getHighBitsUnsigned !== "function" && typeof value.getHighBits !== "function" ||
        typeof value.getLowBitsUnsigned !== "function" && typeof value.getLowBits !== "function") {
      return __codecError("configured driver returned an unsupported BSON Timestamp value");
    }
    var seconds = typeof value.getHighBitsUnsigned === "function" ? value.getHighBitsUnsigned() : value.getHighBits();
    var increment = typeof value.getLowBitsUnsigned === "function" ? value.getLowBitsUnsigned() : value.getLowBits();
    return { $timestamp: { t: seconds >>> 0, i: increment >>> 0 } };
  }
  if (value._bsontype === "MinKey") return { $minKey: 1 };
  if (value._bsontype === "MaxKey") return { $maxKey: 1 };
  // Refuse types that cannot be restored faithfully by the fallback decoder.
  if (value._bsontype || Buffer.isBuffer(value) || Object.prototype.toString.call(value) === "[object RegExp]") {
    return __codecError("configured driver requires EJSON support for this BSON value");
  }
  const result = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(result, key, { value: __fallbackEncode(value[key]), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function __decode(value) {
  if (value === undefined) return value;
  if (__bson && __bson.EJSON && typeof __bson.EJSON.parse === "function") {
    return __bson.EJSON.parse(JSON.stringify(value));
  }
  return __fallbackDecode(value);
}

function __encode(value) {
  if (__bson && __bson.EJSON && typeof __bson.EJSON.stringify === "function") {
    return JSON.parse(__bson.EJSON.stringify(value));
  }
  // Walk BSON values before JSON.stringify calls their toJSON methods.
  return JSON.parse(JSON.stringify(__fallbackEncode(value)));
}
`;
