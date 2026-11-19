// Icons exported from Figma, one set per theme (the Figma icons carry their theme's colours).

import backD from "../assets/icons/dark/back.svg";
import bellD from "../assets/icons/dark/bell.svg";
import bookD from "../assets/icons/dark/book.svg";
import chevronD from "../assets/icons/dark/chevron.svg";
import chevronLgD from "../assets/icons/dark/chevron-lg.svg";
import computerD from "../assets/icons/dark/computer.svg";
import detailsD from "../assets/icons/dark/details.svg";
import dotD from "../assets/icons/dark/dot.svg";
import dotWarningD from "../assets/icons/dark/dot-warning.svg";
import folderD from "../assets/icons/dark/folder.svg";
import folderNavD from "../assets/icons/dark/folder-nav.svg";
import forwardD from "../assets/icons/dark/forward.svg";
import homeD from "../assets/icons/dark/home.svg";
import inboxD from "../assets/icons/dark/inbox.svg";
import micD from "../assets/icons/dark/mic.svg";
import moreD from "../assets/icons/dark/more.svg";
import newSectionD from "../assets/icons/dark/new-section.svg";
import panelD from "../assets/icons/dark/panel.svg";
import plusD from "../assets/icons/dark/plus.svg";
import plusRowD from "../assets/icons/dark/plus-row.svg";
import railNeedsYouD from "../assets/icons/dark/rail-needs-you.svg";
import searchD from "../assets/icons/dark/search.svg";
import sendD from "../assets/icons/dark/send.svg";
import shareD from "../assets/icons/dark/share.svg";
import slidersD from "../assets/icons/dark/sliders.svg";
import backL from "../assets/icons/light/back.svg";
import bellL from "../assets/icons/light/bell.svg";
import bookL from "../assets/icons/light/book.svg";
import chevronL from "../assets/icons/light/chevron.svg";
import chevronLgL from "../assets/icons/light/chevron-lg.svg";
import computerL from "../assets/icons/light/computer.svg";
import detailsL from "../assets/icons/light/details.svg";
import dotL from "../assets/icons/light/dot.svg";
import dotWarningL from "../assets/icons/light/dot-warning.svg";
import folderL from "../assets/icons/light/folder.svg";
import folderNavL from "../assets/icons/light/folder-nav.svg";
import forwardL from "../assets/icons/light/forward.svg";
import homeL from "../assets/icons/light/home.svg";
import inboxL from "../assets/icons/light/inbox.svg";
import micL from "../assets/icons/light/mic.svg";
import moreL from "../assets/icons/light/more.svg";
import newSectionL from "../assets/icons/light/new-section.svg";
import panelL from "../assets/icons/light/panel.svg";
import plusL from "../assets/icons/light/plus.svg";
import plusRowL from "../assets/icons/light/plus-row.svg";
import railNeedsYouL from "../assets/icons/light/rail-needs-you.svg";
import searchL from "../assets/icons/light/search.svg";
import sendL from "../assets/icons/light/send.svg";
import shareL from "../assets/icons/light/share.svg";
import slidersL from "../assets/icons/light/sliders.svg";
import { useTheme } from "../theme.ts";

const ICONS = {
  back: [backL, backD, 16],
  bell: [bellL, bellD, 18],
  book: [bookL, bookD, 18],
  chevron: [chevronL, chevronD, 12],
  "chevron-lg": [chevronLgL, chevronLgD, 14],
  computer: [computerL, computerD, 16],
  details: [detailsL, detailsD, 18],
  dot: [dotL, dotD, 6],
  "dot-warning": [dotWarningL, dotWarningD, 6],
  folder: [folderL, folderD, 16],
  "folder-nav": [folderNavL, folderNavD, 16],
  forward: [forwardL, forwardD, 16],
  home: [homeL, homeD, 18],
  inbox: [inboxL, inboxD, 16],
  mic: [micL, micD, 18],
  more: [moreL, moreD, 18],
  "new-section": [newSectionL, newSectionD, 16],
  panel: [panelL, panelD, 16],
  plus: [plusL, plusD, 18],
  "plus-row": [plusRowL, plusRowD, 18],
  "rail-needs-you": [railNeedsYouL, railNeedsYouD, 38],
  search: [searchL, searchD, 18],
  send: [sendL, sendD, 16],
  share: [shareL, shareD, 18],
  sliders: [slidersL, slidersD, 18],
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  const theme = useTheme();
  const [light, dark, size] = ICONS[name];
  return (
    <img
      alt=""
      aria-hidden="true"
      className={className ? `icon ${className}` : "icon"}
      src={theme === "dark" ? dark : light}
      width={size}
      height={size}
      draggable={false}
    />
  );
}
