import { assertArcalId, piRange, unpackPiDigits } from "./pi.js";
import type { Hex } from "viem";

/**
 * Reference implementation of ArcalsMetadataRenderer.imageSVG. The output is
 * byte-for-byte identical to the contract (checked against shared fixtures),
 * so off-chain image URLs and on-chain data URIs show the same artwork.
 */
const CENTER_X = 5000;
const CENTER_Y = 4700;
const TEXT_RADIUS = 4380;
const TICK_RADIUS = 4180;
const HALF_ADVANCE = 38;
const HALF_CAP = 45;

// round(sin * 1e4) and round(-cos * 1e4) per degree, as in the contract table.
const UNIT_VECTORS = Array.from({ length: 360 }, (_, degree) => {
  const radians = (degree * Math.PI) / 180;
  return [
    Math.round(Math.sin(radians) * 10_000),
    Math.round(-Math.cos(radians) * 10_000),
  ] as const;
});

const SVG_HEAD =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1000 1000'><defs><linearGradient id='s' x1='38' y1='8' x2='962' y2='932' gradientUnits='userSpaceOnUse'><stop stop-color='#5b6875'/><stop offset='.3' stop-color='#fff'/><stop offset='.6' stop-color='#3a4550'/><stop offset='.8' stop-color='#eef5fb'/><stop offset='1' stop-color='#8a98a6'/></linearGradient><filter id='g' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='10'/></filter></defs><rect width='1000' height='1000' fill='#030405'/><circle cx='500' cy='470' r='462' fill='none' stroke='#b9cbdc' stroke-opacity='.16' stroke-width='12' filter='url(#g)'/><circle cx='500' cy='470' r='462' fill='none' stroke='url(#s)' stroke-width='2'/>";

const truncate = (value: number, divisor: number): number =>
  Math.trunc(value / divisor);

function grouped(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function digitRing(digits: string): string {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let degree = 0; degree < 360; degree += 1) {
    const [sine, negCosine] = UNIT_VECTORS[degree]!;
    xs.push(
      CENTER_X +
        truncate(TEXT_RADIUS * sine, 10_000) -
        truncate(HALF_ADVANCE * -negCosine + HALF_CAP * sine, 10_000),
    );
    ys.push(
      CENTER_Y +
        truncate(TEXT_RADIUS * negCosine, 10_000) -
        truncate(HALF_ADVANCE * sine - HALF_CAP * -negCosine, 10_000),
    );
  }
  let svg =
    "<g transform='scale(.1)'><text font-family='monospace' font-size='125' font-weight='700' fill='#fff' " +
    `x='${xs.join(" ")}' y='${ys.join(" ")}' rotate='${Array.from({ length: 360 }, (_, degree) => degree).join(" ")}'>${digits}</text>` +
    "<g stroke='#e4edf6' stroke-width='22' stroke-linecap='round' fill='none'>";
  for (let value = 0; value < 10; value += 1) {
    const inner = TICK_RADIUS - 50 - 95 * value;
    let path = "";
    for (let degree = 0; degree < 360; degree += 1) {
      if (Number(digits[degree]) !== value) continue;
      const [sine, negCosine] = UNIT_VECTORS[degree]!;
      path += `M${CENTER_X + truncate(TICK_RADIUS * sine, 10_000)} ${CENTER_Y + truncate(TICK_RADIUS * negCosine, 10_000)}`;
      path += `L${CENTER_X + truncate(inner * sine, 10_000)} ${CENTER_Y + truncate(inner * negCosine, 10_000)}`;
    }
    if (path !== "") {
      svg += `<path stroke-opacity='.${30 + 7 * value}' d='${path}'/>`;
    }
  }
  return `${svg}</g></g>`;
}

/**
 * The SVG artwork of an Arcal. `packedDigits` is the registered 180-byte
 * content, or null to draw the bare ring shown before registration.
 */
export function arcalArtworkSvg(id: bigint, packedDigits: Hex | null): string {
  assertArcalId(id);
  const range = piRange(id);
  const ring =
    packedDigits === null ? "" : digitRing(unpackPiDigits(packedDigits));
  return `${SVG_HEAD}${ring}<text x='500' y='968' text-anchor='middle' font-family='monospace' font-size='24' letter-spacing='3' fill='#8f9cad'>π ${grouped(range.startDigit)} – ${grouped(range.endDigit)}</text></svg>`;
}
