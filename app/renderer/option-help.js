'use strict';
// What engine options do, in plain words: the tooltip on each row in an
// engine's options. Names are matched ignoring case, spaces and
// underscores, so "Move Overhead", "move_overhead" and "MoveOverhead" are
// one entry. An option without an entry gets its type, range and default.

const OPTION_HELP = {
  // Standard UCI options.
  hash: 'Memory the engine uses to remember positions it has already searched, in MB. More helps long searches; a quarter to half of your free memory is plenty.',
  threads: 'How many processor threads the engine searches with. More threads search faster; the number of cores in your computer is a good choice, a little less if you want to use the computer at the same time.',
  multipv: 'How many different best moves the engine looks at and reports, each with its own line. More lines show you the alternatives but make each one shallower; leave it at 1 for the strongest play.',
  ponder: 'Lets the engine think on its opponent’s time, about the reply it expects. It plays a little stronger but keeps the processor busy all the time.',
  clearhash: 'Empties the engine’s memory of positions it has searched, so the next search starts afresh.',
  uci_showwdl: 'Has the engine report its chances of a win, a draw and a loss along with its score. It does not change how it plays.',
  uci_limitstrength: 'Makes the engine play weaker, at the rating set in UCI_Elo. Turn it on for a fairer game against a person.',
  uci_elo: 'The rating the engine aims to play at when UCI_LimitStrength is on. It has no effect while UCI_LimitStrength is off.',
  uci_chess960: 'Plays Chess960 (Fischer Random), where the pieces start in a shuffled order and castling works differently. Leave it off for ordinary chess.',
  uci_analysemode: 'Tells the engine it is analysing rather than playing a game, so it may turn off things meant only for play, such as its opening book or contempt.',
  uci_opponent: 'The opponent’s title, rating, kind (human or computer) and name, which some engines use to adjust their play. Usually filled in by the program, not by hand.',
  uci_engineabout: 'A line about the engine: its name, its authors and where to find it. It is for information and changes nothing.',

  // Stockfish and engines like it.
  moveoverhead: 'Time in milliseconds the engine keeps back on each move for delays between it and the board, such as a network or a slow computer. Raise it if the engine loses on time; 10 to 100 suits most uses.',
  slowmover: 'How much of its time the engine spends early in the game, in per cent. Higher values spend more time on each move and leave less for later; 100 is the normal pace.',
  nodestime: 'Counts time in nodes searched rather than in seconds, so results do not depend on how fast the computer is. Used for testing engines; leave it at 0 for normal play.',
  skilllevel: 'How well the engine plays, from 0 (weakest) to 20 (full strength). Lower levels make deliberate mistakes, which makes it a gentler opponent.',
  evalfile: 'The neural network the engine uses to judge positions. A value in angle brackets, such as <embedded> or <internal>, names a network built into the engine rather than a file. Leave it at the default unless you have a network made for this engine.',
  evalfilesmall: 'The smaller, faster neural network the engine uses for positions that are clearly won or lost. A value in angle brackets names a network built into the engine rather than a file. Leave it at the default unless you have a network made for this engine.',
  syzygypath: 'The folder holding Syzygy endgame tablebases: files with the perfect result for every position with few pieces. With them the engine plays those endgames perfectly. Leave it empty if you have none.',
  syzygyprobedepth: 'How deep into the search the engine starts looking positions up in the tablebases. Lower values look them up more often, which is more accurate but slower if the files are on a slow disk; 1 suits a fast disk.',
  syzygy50moverule: 'Whether the tablebases take the fifty-move rule into account, so a win that would take too long counts as a draw. Leave it on for normal chess.',
  syzygyprobelimit: 'The largest number of pieces for which the engine looks positions up in the tablebases. Set it to the size of the largest tablebases you have, such as 5, 6 or 7.',
  debuglogfile: 'A file where the engine writes everything sent to and from it, for finding problems. Leave it empty to keep no log.',
  numapolicy: 'How the engine spreads its threads across the processor’s memory regions on large computers with several processor sockets. Leave it at auto unless you know your machine needs otherwise.',

  // Options other engines often have.
  contempt: 'How much the engine avoids draws. Positive values make it play on for a win against a weaker opponent; negative values make it happier to draw against a stronger one. 0 judges draws as they are.',
  minimumthinkingtime: 'The least time the engine spends on any move, in milliseconds, even when the move is obvious.',
  usennue: 'Uses the neural network to judge positions instead of the older hand-written rules. Leave it on: the network plays much stronger.',
  ownbook: 'Lets the engine play opening moves from its own opening book instead of thinking about them. Turn it off to see the engine’s own choices from the first move.',
  bookfile: 'The opening book file the engine plays its opening moves from, when its book is turned on.',
  weightsfile: 'The neural network file Lc0 plays with. Different networks play differently and some are much stronger; leave it at <autodiscover> to use the network found beside the engine.',
  backend: 'How Lc0 runs its neural network: on the graphics card (such as cuda, metal or opencl) or on the processor (such as blas or eigen). Pick one that matches your computer; the graphics card is much faster.',
};

const optionHelpKey = (name) => String(name).toLowerCase().replace(/[\s_]+/g, '');
const OPTION_HELP_BY_KEY = new Map(Object.entries(OPTION_HELP).map(([k, v]) => [optionHelpKey(k), v]));

// The type, range and default, for an option with no description.
function optionFacts(opt) {
  const shown = (v) => (v === '' || v === '<empty>' ? 'empty' : v);
  switch (opt.type) {
    case 'spin': return `Number${opt.min != null && opt.max != null ? `, ${opt.min}–${opt.max}` : ''}, default ${opt.default}`;
    case 'check': return `On or off, default ${opt.default === 'true' ? 'on' : 'off'}`;
    case 'combo': return `One of ${(opt.vars ?? []).join(', ')}; default ${opt.default}`;
    case 'button': return 'A button: it does something at once rather than store a value';
    default: return `Text, default ${shown(opt.default ?? '')}`;
  }
}

// The tooltip for an option: what it does, or else its type and range.
function optionHelp(opt) {
  return OPTION_HELP_BY_KEY.get(optionHelpKey(opt.name)) ?? `${opt.name}: ${optionFacts(opt)}.`;
}
