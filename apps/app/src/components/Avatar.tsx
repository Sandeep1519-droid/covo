// A bot's character (Figma component "Bot avatar"): one of 12 shapes, coloured by overriding the
// Body fill with an avatar colour, as the component's notes say. Drawn inline so the colour can change.

import { AVATAR_COLORS, AVATAR_SHAPES, type AvatarShape } from "@covo/api";
import { useId } from "react";
import bean from "../assets/avatars/bean.svg" with { type: "text" };
import blob from "../assets/avatars/blob.svg" with { type: "text" };
import circle from "../assets/avatars/circle.svg" with { type: "text" };
import cloud from "../assets/avatars/cloud.svg" with { type: "text" };
import diamond from "../assets/avatars/diamond.svg" with { type: "text" };
import drop from "../assets/avatars/drop.svg" with { type: "text" };
import flower from "../assets/avatars/flower.svg" with { type: "text" };
import gem from "../assets/avatars/gem.svg" with { type: "text" };
import hexagon from "../assets/avatars/hexagon.svg" with { type: "text" };
import pill from "../assets/avatars/pill.svg" with { type: "text" };
import squircle from "../assets/avatars/squircle.svg" with { type: "text" };
import triangle from "../assets/avatars/triangle.svg" with { type: "text" };

/** Each shape's drawing and how far it reaches past its box (top, right, bottom, left, in % of the box), from Figma. */
const SHAPES: Record<AvatarShape, [svg: string, inset: [number, number, number, number]]> = {
  Circle: [circle, [0, -4.17, -8.33, -4.17]],
  Squircle: [squircle, [0, -2.08, -6.25, -2.08]],
  Blob: [blob, [0, 0, -4.17, 0]],
  Cloud: [cloud, [0, -6.88, 0, -0.43]],
  Drop: [drop, [0, 0, -8.33, 0]],
  Hexagon: [hexagon, [0, 0, -6.25, 0]],
  Pill: [pill, [0, -4.17, 0, -4.17]],
  Flower: [flower, [0, -2.08, -6.25, -2.08]],
  Triangle: [triangle, [0, 0, 0, 0]],
  Diamond: [diamond, [0, -1.07, -5.23, -1.07]],
  Gem: [gem, [0, 0, 0, 0]],
  Bean: [bean, [0, 0, -0.85, 0]],
};

/** The colour every shape is drawn in, replaced by the bot's own. */
const BASE_FILL = /fill="#5CB8F2"/gi;

/** Colour names from before the Figma palette (Phase 2 bots). */
const OLD_COLORS: Record<string, keyof typeof AVATAR_COLORS> = {
  lavender: "violet",
  sun: "gold",
  peach: "orange",
};

export function avatarColor(name: string): string {
  const c = (OLD_COLORS[name] ?? name) as keyof typeof AVATAR_COLORS;
  return AVATAR_COLORS[c] ?? AVATAR_COLORS.sky;
}

export function Avatar({ shape, color, size }: { shape: string; color: string; size: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const known = (AVATAR_SHAPES as readonly string[]).includes(shape) ? (shape as AvatarShape) : "Blob";
  const [svg, [t, r, b, l]] = SHAPES[known];
  // Filter ids must be unique on the page, or every avatar would share the first one's shading.
  const html = svg
    .replace(BASE_FILL, `fill="${avatarColor(color)}"`)
    .replace(/id="(filter[^"]+)"/g, `id="$1_${uid}"`)
    .replace(/url\(#(filter[^)]+)\)/g, `url(#$1_${uid})`);
  return (
    <span className="avatar" style={{ width: size, height: size }} aria-hidden="true">
      <span
        className="avatar-art"
        style={{ top: `${t}%`, right: `${r}%`, bottom: `${b}%`, left: `${l}%` }}
        // Our own bundled drawing, with only colours and ids changed.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static SVG shipped with the app
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </span>
  );
}
