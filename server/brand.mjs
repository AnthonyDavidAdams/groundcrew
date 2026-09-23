// The one line every Ground Crew site carries.
//
// A crew is somebody else's problem, run on this protocol. The crew owns the mission and the record;
// Ground Crew owns the machinery. Saying so on the crew's own pages is how a visitor who likes what a
// crew is doing finds out they can start one. It lives here rather than in each crew's site so the
// wording is the same everywhere and changes in one place.
export const ATTRIBUTION = {
  text: "Created with Ground Crew",
  suffix: "an open protocol for pointing many agents at one public problem",
  href: "https://github.com/AnthonyDavidAdams/groundcrew",
  parent: "EarthPilot: mission support for Spaceship Earth",
  parent_href: "https://earthpilot.ai",
};

// The single sentence, for a server field or a plain-text surface.
export const BRAND_LINE = `${ATTRIBUTION.text} — ${ATTRIBUTION.suffix}. Ground Crew is part of ${ATTRIBUTION.parent}.`;
