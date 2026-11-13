// What to say about an opening when its name is pointed at: where it comes
// from, what it is good for and what it costs. The write-ups are by family
// and by the best-known variations; a line deeper in the book gets the
// write-up of the nearest one above it ("Sicilian Defense: Najdorf
// Variation, English Attack" is told about the Najdorf).
//
// Keys are names as the built-in book spells them. m: the moves that make
// the opening; h: its history; s: its strengths; w: its weaknesses.
const OPENING_INFO = {
  // --- 1. e4 e5 ---
  'Ruy Lopez': {
    m: '1. e4 e5 2. Nf3 Nc6 3. Bb5',
    h: 'Named after the Spanish priest Ruy López de Segura, who analysed it in his book of 1561. It has been the main battleground of 1. e4 e5 since the nineteenth century and has featured in most world championship matches.',
    s: 'White puts lasting pressure on e5 and the centre without committing early, keeping a small, durable edge and a choice between slow manoeuvring and sharp play.',
    w: 'The theory is enormous, and the bishop on b5 can be chased with tempo. Solid replies such as the Berlin and the Marshall have made a real advantage hard to prove.',
  },
  'Ruy Lopez: Berlin Defense': {
    m: '1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6',
    h: 'An old nineteenth-century defence, revived by Vladimir Kramnik to neutralise Garry Kasparov in their 2000 world championship match. Its queenless endgame earned the nickname "the Berlin Wall".',
    s: 'Extremely solid for Black: the main line trades queens early and gives Black the bishop pair and a structure that is very hard to break down.',
    w: 'Black gives up castling and accepts doubled pawns, with few winning chances. The endgame demands patient, precise defence, and White can avoid it with 4. d3.',
  },
  'Ruy Lopez: Marshall Attack': {
    m: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 O-O 8. c3 d5',
    h: 'Introduced by Frank Marshall against José Raúl Capablanca in New York in 1918. Capablanca won that game, but the gambit turned out to be sound and is still played at the top.',
    s: 'Black gives a pawn for a lasting attack on the white king and very active pieces. Even with best play White often has to return the pawn to reach a drawn endgame.',
    w: 'It needs deep memorised theory, and White can sidestep it altogether with the Anti-Marshall lines (8. a4 or 8. h3).',
  },
  'Ruy Lopez: Exchange Variation': {
    m: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6',
    h: 'Used by Emanuel Lasker to beat Capablanca at St. Petersburg in 1914, and turned into a real weapon by Bobby Fischer in the 1960s.',
    s: 'White doubles Black\'s pawns and aims for an endgame in which the healthy kingside majority can make a passed pawn while Black\'s cannot.',
    w: 'Black gets the bishop pair and easy development. If the queens stay on, the bishops usually count for more than the pawn structure.',
  },
  'Ruy Lopez: Closed': {
    m: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7',
    h: 'The classical main line, refined over a century by players from Steinitz and Chigorin to Karpov and Kasparov. Many of its sub-lines carry their names.',
    s: 'Both sides keep all the pieces and a tense centre, which leads to rich manoeuvring games where understanding counts for more than memory.',
    w: 'Black is slightly cramped for a long time, and White\'s slow build-up (the "Spanish torture") can be unpleasant to sit through.',
  },
  'Ruy Lopez: Open': {
    m: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Nxe4',
    h: 'Championed by Siegbert Tarrasch, later by Max Euwe and above all Viktor Korchnoi, who relied on it in his world championship matches with Karpov.',
    s: 'Black takes a central pawn, gets active pieces and a queenside pawn majority instead of the passive defence of the Closed lines.',
    w: 'Black\'s pawn structure is loose, the knight on e4 can become a target, and the weakened dark squares give White lasting chances.',
  },
  'Italian Game': {
    m: '1. e4 e5 2. Nf3 Nc6 3. Bc4',
    h: 'One of the oldest recorded openings, studied by Italian masters such as Greco in the sixteenth and seventeenth centuries. It has come back strongly at the top since the 2010s as a way to avoid the Berlin.',
    s: 'Natural, fast development with the bishop aimed at f7. White can choose between slow manoeuvring and sharp gambit play.',
    w: 'The bishop on c4 can be hit by ...d5 or ...Na5, and Black equalises fairly comfortably with accurate play.',
  },
  'Italian Game: Giuoco Piano': {
    m: '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5',
    h: 'The "quiet game" of the old Italian school. Its slow form with d3 and c3 (the Giuoco Pianissimo) is one of the most common openings in modern elite chess.',
    s: 'Sound development for both sides and a flexible centre. White keeps the tension and manoeuvres the knights without forcing matters.',
    w: 'Play is slow and symmetrical, so an advantage is hard to come by. The sharper 4. c3 and 5. d4 lines are well worked out to equality.',
  },
  'Italian Game: Evans Gambit': {
    m: '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4',
    h: 'Invented by the Welsh sea captain William Davies Evans in the 1820s and a favourite of the romantic era. Kasparov revived it to beat Anand in 1995.',
    s: 'For a wing pawn White gains time to build a big centre with c3 and d4 and gets open lines for an attack.',
    w: 'Black can give the pawn back for a safe game or keep it and defend. Against accurate play White\'s compensation is no more than adequate.',
  },
  'Italian Game: Two Knights Defense': {
    m: '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6',
    h: 'Analysed as early as the sixteenth century. Tarrasch called 4. Ng5 "a duffer\'s move", yet the complications it starts have been argued over ever since.',
    s: 'Black counter-attacks e4 at once instead of defending, and often gives a pawn for the initiative and active pieces.',
    w: 'After 4. Ng5 Black must know what to do: the Fried Liver sacrifice and its relatives punish a careless reply quickly.',
  },
  'Scotch Game': {
    m: '1. e4 e5 2. Nf3 Nc6 3. d4',
    h: 'Named after a correspondence match between Edinburgh and London in 1824. It was thought harmless for most of the twentieth century until Kasparov took it up in 1990.',
    s: 'White opens the centre immediately, avoids the heavy theory of the Ruy Lopez and gets free piece play and space.',
    w: 'The early release of tension lets Black develop with tempo and equalise more easily than in the Ruy Lopez.',
  },
  'Petrov\'s Defense': {
    m: '1. e4 e5 2. Nf3 Nf6',
    h: 'Named after the Russian master Alexander Petrov, who analysed it in the nineteenth century. Also called the Russian Game, it is a mainstay of elite players who want a safe reply to 1. e4.',
    s: 'Very solid and symmetrical. Black avoids the Ruy Lopez and the Italian and usually reaches an equal, easy-to-handle position.',
    w: 'It has a drawish reputation and offers Black few winning chances. A few early traps, such as taking on e4 too soon, catch the unwary.',
  },
  'Four Knights Game': {
    m: '1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6',
    h: 'A staple of the late nineteenth and early twentieth centuries, when quiet symmetrical development was the fashion.',
    s: 'Simple, sound development by the rules. It is easy to learn and hard to go badly wrong in.',
    w: 'Symmetry makes it drawish, and Black has several comfortable ways to equalise, including Rubinstein\'s 4...Nd4.',
  },
  'Philidor Defense': {
    m: '1. e4 e5 2. Nf3 d6',
    h: 'Recommended by François-André Danican Philidor in the eighteenth century, who valued pawns above all ("the soul of chess").',
    s: 'Solid and compact. Black keeps the e5 point and can reach it by move orders that avoid a lot of theory.',
    w: 'Passive: the bishop on f8 is shut in and Black has less space, so White gets a freer game with little risk.',
  },
  'King\'s Gambit': {
    m: '1. e4 e5 2. f4',
    h: 'The signature opening of the romantic era, behind many nineteenth-century brilliancies. Fischer wrote "A Bust to the King\'s Gambit" in 1961 and it has been rare at the top since.',
    s: 'White offers a pawn to pull Black\'s e-pawn away, build a big centre and open the f-file for an attack.',
    w: 'It loosens White\'s own king. With accurate defence Black keeps the pawn or returns it for a good game, and engines do not trust it.',
  },
  'King\'s Gambit Accepted': {
    m: '1. e4 e5 2. f4 exf4',
    h: 'The main test of the gambit, and the stage for the "Immortal Game" (Anderssen–Kieseritzky, 1851) and countless other attacking classics.',
    s: 'White gets a central majority and the half-open f-file; Black gets a pawn and can often hang on to it with ...g5.',
    w: 'White\'s king is draughty and the pawn may never come back. Black\'s extra pawn chain on the kingside can itself turn into an attack.',
  },
  'King\'s Gambit Declined': {
    m: '1. e4 e5 2. f4 Bc5',
    h: 'The classical way to refuse the pawn, pointing the bishop at the diagonal White has just weakened. The Falkbeer Countergambit (2...d5) is the sharper refusal.',
    s: 'Black develops quickly, stops White castling for a while and avoids the heaviest gambit theory.',
    w: 'White keeps the extra space and can still open the f-file later, without having given anything up.',
  },
  'Vienna Game': {
    m: '1. e4 e5 2. Nc3',
    h: 'Developed by Viennese masters such as Carl Hamppe in the nineteenth century as a slower way to prepare f4.',
    s: 'Flexible: White can play a delayed King\'s Gambit with f4, or a quiet system with Bc4 and d3, and Black gets fewer forcing lines to learn.',
    w: 'It puts less direct pressure on e5 than 2. Nf3, so Black equalises without much trouble, for instance with 2...Nf6 and ...d5.',
  },
  'Bishop\'s Opening': {
    m: '1. e4 e5 2. Bc4',
    h: 'Among the oldest openings, favoured by Philidor. Bent Larsen brought it back in the 1960s and it is used today to avoid the Petrov.',
    s: 'Keeps the f-pawn free to advance and often transposes to the Italian or the Vienna on White\'s terms.',
    w: 'It commits the bishop early and does not attack e5, so Black can reply 2...Nf6 and aim for ...d5 with a comfortable game.',
  },
  'Center Game': {
    m: '1. e4 e5 2. d4 exd4 3. Qxd4',
    h: 'An old opening seen in the nineteenth century, occasionally revived as a surprise weapon.',
    s: 'Opens the centre at once and often leads to opposite-side castling with attacking chances.',
    w: 'The queen comes out early and Black gains time by attacking it with ...Nc6.',
  },
  'Danish Gambit': {
    m: '1. e4 e5 2. d4 exd4 3. c3',
    h: 'Popularised by Danish players in the nineteenth century and a favourite of attacking masters of that era.',
    s: 'White gives one or two pawns for two raking bishops and a big lead in development.',
    w: 'Black can give the material back with ...d5 to reach an equal or better endgame; against good defence the attack runs dry.',
  },
  'Ponziani Opening': {
    m: '1. e4 e5 2. Nf3 Nc6 3. c3',
    h: 'Analysed by Domenico Ponziani in the eighteenth century. It is one of the oldest openings and has never been fashionable.',
    s: 'Prepares d4 with a pawn and takes most opponents out of their preparation.',
    w: 'The pawn takes the knight\'s natural square c3, and Black equalises at once with 3...Nf6 or 3...d5.',
  },
  'Latvian Gambit': {
    m: '1. e4 e5 2. Nf3 f5',
    h: 'Analysed by Latvian players, notably Kārlis Bētiņš, in the early twentieth century; it is a King\'s Gambit with colours reversed and a move less.',
    s: 'Very sharp, and full of traps for a White player who does not know the theory.',
    w: 'Objectively dubious: with correct play White gets a clear advantage, and it is almost never seen in serious over-the-board chess.',
  },
  'Elephant Gambit': {
    m: '1. e4 e5 2. Nf3 d5',
    h: 'An old countergambit also known as the Queen\'s Pawn Countergambit, played mostly in club and blitz chess.',
    s: 'Black opens lines at once and hopes to catch White off guard.',
    w: 'Unsound: after 3. exd5 White simply ends up a pawn ahead or with a big lead in development.',
  },

  // --- 1. e4, other replies ---
  'Sicilian Defense': {
    m: '1. e4 c5',
    h: 'Mentioned by Polerio in the sixteenth century; it took its name in the early nineteenth century from the old Italian "il giuoco siciliano". Since the mid-twentieth century it has been the most popular and best-scoring reply to 1. e4.',
    s: 'Black fights for d4 from the wing and gets an unbalanced position: a half-open c-file, an extra centre pawn after ...cxd4, and real winning chances.',
    w: 'White gets a lead in development and attacking chances on the kingside, and the main lines carry more theory than any other opening.',
  },
  'Sicilian Defense: Najdorf Variation': {
    m: '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6',
    h: 'Named after the Polish-Argentine grandmaster Miguel Najdorf, who developed it in the 1940s. It was the lifelong main weapon of both Bobby Fischer and Garry Kasparov.',
    s: 'The little move ...a6 keeps White\'s pieces out of b5 and keeps Black\'s options open: ...e5 or ...e6, and queenside expansion with ...b5.',
    w: 'Black falls behind in development, and White has many dangerous tries (6. Bg5, the English Attack, 6. Bc4) that each need exact knowledge.',
  },
  'Sicilian Defense: Dragon Variation': {
    m: '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 g6',
    h: 'Named around 1901 by the Russian master Fyodor Dus-Chotimirsky, who saw the constellation Draco in Black\'s pawn structure.',
    s: 'The bishop on g7 rakes the long diagonal, and Black gets a ready-made attack down the c-file, often with an exchange sacrifice on c3.',
    w: 'In the Yugoslav Attack White castles long and storms the h-file; one slip there is usually fatal, and the lines are analysed very deeply.',
  },
  'Sicilian Defense: Accelerated Dragon': {
    m: '1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 g6',
    h: 'A move order that fianchettoes before playing ...d6, used by many players who like the Dragon bishop without the Yugoslav Attack.',
    s: 'Black keeps the option of ...d5 in one move, which takes the sting out of White\'s usual attacking set-up.',
    w: 'It allows the Maróczy Bind (5. c4), where White\'s pawns on c4 and e4 leave Black solid but short of space and counterplay.',
  },
  'Sicilian Defense: Scheveningen Variation': {
    m: '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 e6',
    h: 'Named after the Dutch seaside town where it was played in a 1923 tournament. Kasparov used it throughout his matches with Karpov in the 1980s.',
    s: 'The small centre with pawns on d6 and e6 is very flexible and resilient; Black covers the key squares and counter-attacks on the queenside.',
    w: 'Black has less space, and the Keres Attack (6. g4) is so dangerous that many players reach the structure through the Najdorf instead.',
  },
  'Sicilian Defense: Lasker-Pelikan Variation, Sveshnikov Variation': {
    m: '1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 e5 6. Ndb5 d6',
    h: 'Worked out in the 1970s by Evgeny Sveshnikov and Gennady Timoshchenko in Chelyabinsk. Magnus Carlsen made it his main defence in the 2018 world championship match.',
    s: 'Black gains time and space with ...e5 and gets very active pieces, the bishop pair in many lines, and play with ...f5.',
    w: 'Black accepts a permanent hole on d5 and a backward d-pawn; if the activity fades, those weaknesses remain.',
  },
  'Sicilian Defense: Taimanov Variation': {
    m: '1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 Nc6',
    h: 'Named after the Soviet grandmaster and concert pianist Mark Taimanov, who built it into a system in the 1950s and 60s.',
    s: 'Very flexible: Black delays ...d6 and ...Nf6, keeps the f8 bishop free to go to b4 or c5, and can switch between several set-ups.',
    w: 'The d6 square can become weak, and White has a wide choice of plans, so Black needs to know many different structures.',
  },
  'Sicilian Defense: Kan Variation': {
    m: '1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 a6',
    h: 'Named after the Soviet master Ilya Kan; also called the Paulsen after Louis Paulsen, who played these set-ups in the nineteenth century.',
    s: 'One of the most flexible Sicilians: Black commits very little and can develop in several ways depending on what White does.',
    w: 'Black is slow to develop, and White can take space with a Maróczy set-up (5. c4) or develop freely with 5. Bd3.',
  },
  'Sicilian Defense: Richter-Rauzer Variation': {
    m: '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 Nc6 6. Bg5',
    h: 'Named after Kurt Richter and Vsevolod Rauzer, who developed it in the 1930s as the main answer to the Classical Sicilian.',
    s: 'White develops with a threat, prepares to castle long and puts pressure on d6 and the pinned knight.',
    w: 'Black often accepts doubled f-pawns in return for the bishop pair and a solid centre, and opposite-side castling cuts both ways.',
  },
  'Sicilian Defense: Alapin Variation': {
    m: '1. e4 c5 2. c3',
    h: 'Named after the Russian master Semyon Alapin. Evgeny Sveshnikov later championed it from the white side, and it is a popular way to avoid Open Sicilian theory.',
    s: 'White prepares d4 with a pawn to build a classical centre, and has far less to learn than in the open lines.',
    w: 'The pawn takes away the knight\'s square c3, so Black can hit e4 at once with 2...Nf6 or 2...d5 and equalise.',
  },
  'Sicilian Defense: Closed': {
    m: '1. e4 c5 2. Nc3',
    h: 'A favourite of Vasily Smyslov and, above all, Boris Spassky, who used it to win his 1968 candidates match against Geller.',
    s: 'White keeps the centre closed, fianchettoes the king\'s bishop and builds a slow kingside attack with f4, avoiding open-line theory.',
    w: 'It does not challenge Black in the centre, and Black gets easy development and queenside play with ...Rb8 and ...b5.',
  },
  'Sicilian Defense: Smith-Morra Gambit': {
    m: '1. e4 c5 2. d4 cxd4 3. c3',
    h: 'Named after Pierre Morra of France and Ken Smith of Texas, who wrote about it and played it in the 1972 San Antonio tournament.',
    s: 'For a pawn White gets a lead in development and open c- and d-files; it is dangerous in club and fast chess.',
    w: 'Well-prepared defenders either keep the pawn safely or decline with 3...Nf6, and it is rarely trusted at master level.',
  },
  'Sicilian Defense: Grand Prix Attack': {
    m: '1. e4 c5 2. Nc3 Nc6 3. f4',
    h: 'Named after the British weekend "Grand Prix" tournaments of the 1970s and 80s, where it scored heavily.',
    s: 'A simple attacking scheme: f4, Nf3, a bishop on c4 or b5 and a direct assault on the black king.',
    w: 'Black equalises with an early ...d5 or ...e6 and ...d5, after which White\'s f-pawn advance can look loosening.',
  },
  'French Defense': {
    m: '1. e4 e6',
    h: 'Named after a correspondence match in 1834 in which Paris, playing this defence, beat London. Botvinnik, Petrosian and Korchnoi were among its great exponents.',
    s: 'Solid and counter-attacking: Black challenges the centre with ...d5, gets a sturdy pawn chain and clear plans against d4 with ...c5 and ...f6.',
    w: 'The bishop on c8 is shut in behind the e6 pawn, and Black often has less space, especially on the kingside.',
  },
  'French Defense: Winawer Variation': {
    m: '1. e4 e6 2. d4 d5 3. Nc3 Bb4',
    h: 'Named after the Polish master Szymon Winawer; developed into a main line by Nimzowitsch and Botvinnik.',
    s: 'Black pins the knight and is ready to give the bishop to wreck White\'s queenside pawns, which leads to unbalanced, double-edged play.',
    w: 'Black gives up the dark-squared bishop, and the Poisoned Pawn line (7. Qg4) leaves the black kingside very exposed.',
  },
  'French Defense: Tarrasch Variation': {
    m: '1. e4 e6 2. d4 d5 3. Nd2',
    h: 'Named after Siegbert Tarrasch. Anatoly Karpov used it with great success, notably against Korchnoi in 1974.',
    s: 'White avoids the pin of the Winawer and keeps the c-pawn free to support the centre with c3, with little risk.',
    w: 'The knight on d2 is passive and blocks the bishop, so Black gets easy play with 3...c5, sometimes accepting an isolated pawn.',
  },
  'French Defense: Advance Variation': {
    m: '1. e4 e6 2. d4 d5 3. e5',
    h: 'Advocated by Aron Nimzowitsch in the 1920s as an illustration of his ideas about pawn chains.',
    s: 'White takes space, cramps Black\'s kingside and has a clear plan of defending d4 and playing on the kingside.',
    w: 'The d4 pawn becomes a fixed target for ...c5, ...Nc6 and ...Qb6, and Black knows exactly what to attack.',
  },
  'French Defense: Exchange Variation': {
    m: '1. e4 e6 2. d4 d5 3. exd5 exd5',
    h: 'Long seen as a drawing line, though Paul Morphy played it to open the game and Kasparov used it occasionally to win.',
    s: 'Simple and risk-free; White frees both bishops and avoids the closed French structures.',
    w: 'It frees Black\'s problem bishop too and leaves a symmetrical position that is hard to win.',
  },
  'French Defense: Classical Variation': {
    m: '1. e4 e6 2. d4 d5 3. Nc3 Nf6',
    h: 'The oldest main line, played by Steinitz and Lasker; it leads to the Steinitz (4. e5) and the Burn and MacCutcheon lines after 4. Bg5.',
    s: 'Black develops naturally and attacks e4, keeping the dark-squared bishop that the Winawer gives up.',
    w: 'White gains space with e5 and a kingside initiative, and Black must play precisely to free the position.',
  },
  'French Defense: Rubinstein Variation': {
    m: '1. e4 e6 2. d4 d5 3. Nc3 dxe4',
    h: 'Named after Akiba Rubinstein. It is a popular low-maintenance defence that works against both 3. Nc3 and 3. Nd2.',
    s: 'Black gives up the centre for a solid, simple position with little theory and no weaknesses.',
    w: 'White gets more space and freer development, and Black has few chances to play for a win.',
  },
  'Caro-Kann Defense': {
    m: '1. e4 c6',
    h: 'Named after Horatio Caro and Marcus Kann, who analysed it in the 1880s. It was a mainstay of Capablanca, Botvinnik, Petrosian and Karpov.',
    s: 'Very solid: Black supports ...d5 without shutting in the queen\'s bishop, and gets a sound structure and good endgames.',
    w: 'Black is slower to counter-attack than in the Sicilian or French, and White usually keeps a little more space.',
  },
  'Caro-Kann Defense: Advance Variation': {
    m: '1. e4 c6 2. d4 d5 3. e5',
    h: 'Once thought harmless because Black\'s bishop gets out to f5; it became the critical test after the sharp lines of the 1980s and Nigel Short\'s quiet system in the 1990s.',
    s: 'White gains space and can attack the bishop on f5 with the kingside pawns or simply develop behind the pawn chain.',
    w: 'Black gets the "good French": the bishop is outside the chain and ...c5 hits the base of White\'s centre.',
  },
  'Caro-Kann Defense: Classical Variation': {
    m: '1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5',
    h: 'The traditional main line, played by Capablanca and central to Karpov\'s repertoire.',
    s: 'Black develops the bishop actively and reaches a very sound position with no weaknesses.',
    w: 'White gains time chasing the bishop with Ng3 and h4–h5 and keeps a small space advantage.',
  },
  'Caro-Kann Defense: Panov Attack': {
    m: '1. e4 c6 2. d4 d5 3. exd5 cxd5 4. c4',
    h: 'Named after the Soviet master Vasily Panov, who analysed it around 1930; Botvinnik made it a formidable weapon.',
    s: 'White gets open lines and active pieces, usually with an isolated queen\'s pawn that supports an attack.',
    w: 'The isolated pawn is a long-term weakness; if Black blockades it and trades pieces, the endgame favours Black.',
  },
  'Caro-Kann Defense: Exchange Variation': {
    m: '1. e4 c6 2. d4 d5 3. exd5 cxd5',
    h: 'Bobby Fischer used it with 4. Bd3 to beat Petrosian in the 1970 USSR v. Rest of the World match.',
    s: 'A simple set-up that stops Black\'s bishop reaching f5 and gives White easy development.',
    w: 'The structure is a reversed Queen\'s Gambit Exchange in which Black gets a minority attack and comfortable equality.',
  },
  'Scandinavian Defense': {
    m: '1. e4 d5',
    h: 'One of the oldest recorded openings, appearing in a fifteenth-century Valencian poem. Scandinavian masters analysed it in the nineteenth century, and Anand played it against Kasparov in their 1995 title match.',
    s: 'It forces the play from move one, sidesteps White\'s preparation and leads to a solid Caro-Kann-like structure.',
    w: 'After 2. exd5 Qxd5 the queen is developed early and White gains time by attacking it with Nc3.',
  },
  'Alekhine Defense': {
    m: '1. e4 Nf6',
    h: 'Introduced at top level by Alexander Alekhine in Budapest in 1921, and one of the founding ideas of the hypermodern school.',
    s: 'Black tempts the white pawns forward and then attacks the over-extended centre.',
    w: 'The knight is driven around the board while White takes a lot of space; if the centre holds, Black is simply cramped.',
  },
  'Pirc Defense': {
    m: '1. e4 d6 2. d4 Nf6 3. Nc3 g6',
    h: 'Named after the Slovenian grandmaster Vasja Pirc, who made it respectable in the mid-twentieth century.',
    s: 'A flexible hypermodern defence: Black lets White build a centre and then undermines it with ...e5 or ...c5.',
    w: 'White gets space and a free hand; aggressive set-ups such as the Austrian Attack and the 150 Attack can be dangerous.',
  },
  'Modern Defense': {
    m: '1. e4 g6',
    h: 'Developed in the 1960s and 70s by players such as Robatsch, Suttles and Keene as an even more flexible cousin of the Pirc.',
    s: 'Black commits almost nothing and can choose a set-up after seeing White\'s; it works against nearly any first move.',
    w: 'White is given the whole centre, and Black can end up passive or under a direct attack if the counterplay comes too late.',
  },
  'Nimzowitsch Defense': {
    m: '1. e4 Nc6',
    h: 'Named after Aron Nimzowitsch, who played it in the 1920s; Tony Miles used it later as a surprise weapon.',
    s: 'It takes White out of main-line theory at once and can transpose to several other openings.',
    w: 'The knight blocks the c-pawn, and White gets a broad centre with 2. d4 without having to work for it.',
  },
  'Owen Defense': {
    m: '1. e4 b6',
    h: 'Named after the English clergyman John Owen, who beat Paul Morphy with it in an offhand game in 1858.',
    s: 'Simple to play: the bishop on b7 bears down on e4 and the long diagonal.',
    w: 'White is allowed a full centre with d4 and Bd3, and Black struggles for space and counterplay.',
  },
  'St. George Defense': {
    m: '1. e4 a6',
    h: 'Famous for one game: Tony Miles used it to beat world champion Anatoly Karpov at Skara in 1980.',
    s: 'Pure surprise value, with a queenside fianchetto after ...b5 and ...Bb7.',
    w: 'It does nothing for the centre or development, and White gets a comfortable advantage with natural moves.',
  },

  // --- 1. d4 d5 ---
  'Queen\'s Gambit': {
    m: '1. d4 d5 2. c4',
    h: 'Known since the Göttingen manuscript of 1490 and the dominant opening of the classical era; the 1927 Alekhine–Capablanca match was played almost entirely in it.',
    s: 'White offers a wing pawn to draw Black\'s d-pawn away and take the centre; it is not a true gambit, since the pawn can be won back.',
    w: 'Black has several fully sound replies (declining, accepting, the Slav), so White gets pressure rather than a clear advantage.',
  },
  'Queen\'s Gambit Declined': {
    m: '1. d4 d5 2. c4 e6',
    h: 'The classical defence to the Queen\'s Gambit, played by every world champion. It was the main battleground of the Capablanca–Alekhine and Karpov–Kasparov matches.',
    s: 'Rock solid: Black keeps a pawn on d5, develops naturally and has a structure with no weaknesses.',
    w: 'The bishop on c8 is hemmed in by the e6 pawn, and Black is a little passive while White builds pressure.',
  },
  'Queen\'s Gambit Declined: Exchange Variation': {
    m: '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. cxd5 exd5',
    h: 'Refined by Botvinnik and later Kasparov, who showed how many plans the fixed structure hides.',
    s: 'White gets a clear plan: the minority attack with b4–b5 on the queenside, or a central advance with f3 and e4.',
    w: 'The exchange frees Black\'s light-squared bishop and gives Black the half-open e-file and a solid, well-understood position.',
  },
  'Queen\'s Gambit Accepted': {
    m: '1. d4 d5 2. c4 dxc4',
    h: 'Recorded since the fifteenth century and trusted by players from Steinitz to Anand. Modern practice returns the pawn rather than clinging to it.',
    s: 'Black frees the position at once, gets easy development and usually plays ...c5 to dissolve White\'s centre.',
    w: 'It gives up the centre for a while; White gets a pawn majority there and often an isolated queen\'s pawn with attacking chances.',
  },
  'Slav Defense': {
    m: '1. d4 d5 2. c4 c6',
    h: 'Analysed in the sixteenth century and developed by Slavic masters such as Alapin and Bogoljubov. It was central to the Alekhine–Euwe matches of the 1930s.',
    s: 'Black defends d5 without shutting in the queen\'s bishop, which can come out to f5 or g4; the structure is extremely sound.',
    w: 'The c6 pawn takes the knight\'s best square, and the Exchange Variation can lead to a dull, symmetrical game.',
  },
  'Semi-Slav Defense': {
    m: '1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 e6',
    h: 'A fusion of the Slav and the Queen\'s Gambit Declined. Its sharpest lines, the Meran and the Botvinnik, date from the 1920s and 40s, and it was a pillar of Kramnik\'s and Anand\'s repertoires.',
    s: 'A very solid triangle of pawns with a hidden threat to take on c4 and keep the pawn, leading to rich, fighting positions.',
    w: 'The queen\'s bishop is shut in for the moment, and the critical lines are among the most complicated and heavily analysed in chess.',
  },
  'Tarrasch Defense': {
    m: '1. d4 d5 2. c4 e6 3. Nc3 c5',
    h: 'Championed by Siegbert Tarrasch, who thought it the only correct defence. Spassky used it to win the 1969 world title and Kasparov played it in the early 1980s.',
    s: 'Black gets free, active piece play and open lines in return for an isolated queen\'s pawn.',
    w: 'The isolated d-pawn is a permanent target, especially against the Rubinstein set-up with g3 and Bg2.',
  },
  'Catalan Opening': {
    m: '1. d4 Nf6 2. c4 e6 3. g3',
    h: 'Named after Catalonia: Savielly Tartakower introduced it at the Barcelona tournament of 1929. Kramnik used it to beat Topalov in 2006 and it has been a top-level main line since.',
    s: 'The bishop on g2 presses along the long diagonal against Black\'s queenside; White gets lasting, low-risk pressure.',
    w: 'Black can take on c4 and make White spend time winning the pawn back, or set up a solid closed structure.',
  },
  'London System': {
    m: '1. d4 d5 2. Bf4',
    h: 'Named after the London tournament of 1922, where several masters used it. It became hugely popular in the 2010s, helped by Gata Kamsky and Magnus Carlsen.',
    s: 'A set-up rather than a sequence: Bf4, e3, c3, Nf3 against almost anything, solid and with very little theory to learn.',
    w: 'It puts no early pressure on Black, who can equalise comfortably; ...c5 and ...Qb6 against b2 is the standard test.',
  },
  'Queen\'s Pawn Game: London System': {
    m: '1. d4 d5 2. Nf3 Nf6 3. Bf4',
    h: 'Named after the London tournament of 1922, where several masters used it. It became hugely popular in the 2010s, helped by Gata Kamsky and Magnus Carlsen.',
    s: 'A set-up rather than a sequence: Bf4, e3, c3, Nf3 against almost anything, solid and with very little theory to learn.',
    w: 'It puts no early pressure on Black, who can equalise comfortably; ...c5 and ...Qb6 against b2 is the standard test.',
  },
  'Queen\'s Pawn Game: Colle System': {
    m: '1. d4 d5 2. Nf3 Nf6 3. e3',
    h: 'Named after the Belgian master Edgard Colle, who played it constantly in the 1920s; George Koltanowski popularised it afterwards.',
    s: 'An easy system of development (Bd3, c3, Nbd2) that prepares the central break e4 and a kingside attack.',
    w: 'The queen\'s bishop is shut in behind the e3 pawn, and Black equalises easily with sensible development.',
  },
  'Queen\'s Pawn Game: Torre Attack': {
    m: '1. d4 Nf6 2. Nf3 e6 3. Bg5',
    h: 'Named after the Mexican master Carlos Torre, who beat Emanuel Lasker with it in Moscow in 1925 with a famous "windmill" combination.',
    s: 'Simple development with a pin on the knight and a solid centre; little theory is needed.',
    w: 'Black can question the bishop with ...h6 and gain the bishop pair, or play ...c5 and ...Qb6 to hit b2.',
  },
  'Torre Attack': {
    m: '1. d4 Nf6 2. Nf3 e6 3. Bg5',
    h: 'Named after the Mexican master Carlos Torre, who beat Emanuel Lasker with it in Moscow in 1925 with a famous "windmill" combination.',
    s: 'Simple development with a pin on the knight and a solid centre; little theory is needed.',
    w: 'Black can question the bishop with ...h6 and gain the bishop pair, or play ...c5 and ...Qb6 to hit b2.',
  },
  'Trompowsky Attack': {
    m: '1. d4 Nf6 2. Bg5',
    h: 'Named after the Brazilian champion Octávio Trompowsky, who played it in the 1930s. Julian Hodgson made it a feared weapon in the 1990s.',
    s: 'It avoids the Indian defences altogether and threatens to double Black\'s pawns, leading to original positions early.',
    w: 'The bishop can be harassed with ...Ne4 or ...h6, and White often has to give it up for the knight.',
  },
  'Blackmar-Diemer Gambit': {
    m: '1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. f3',
    h: 'Armand Blackmar proposed the idea in the 1880s and Emil Josef Diemer devoted himself to it in the mid-twentieth century. It has a loyal club following.',
    s: 'White gets rapid development and open lines against the king for one pawn, and many practical chances.',
    w: 'Objectively the pawn is not fully compensated: careful defence leaves Black simply a pawn up.',
  },
  'Richter-Veresov Attack': {
    m: '1. d4 d5 2. Nc3 Nf6 3. Bg5',
    h: 'Named after Kurt Richter and Gavriil Veresov, who played it from the 1930s to the 1950s.',
    s: 'Quick piece development with ideas of f3 and e4, and it steers clear of Queen\'s Gambit theory.',
    w: 'The knight on c3 blocks the c-pawn, so White cannot put the usual pressure on d5, and Black equalises easily.',
  },
  'Englund Gambit': {
    m: '1. d4 e5',
    h: 'Named after the Swedish player Fritz Englund, who sponsored a thematic tournament with it in 1932.',
    s: 'It sets one well-known trap that wins quickly against careless play.',
    w: 'Unsound: White keeps an extra pawn or a clear positional advantage with simple, natural moves.',
  },

  // --- 1. d4 Nf6 ---
  'Indian Defense': {
    m: '1. d4 Nf6',
    h: 'The name goes back to the Indian master Moheschunder Bannerjee, whose games with John Cochrane in the 1850s featured these fianchetto set-ups. The hypermoderns made them mainstream in the 1920s.',
    s: 'Black stops e4 for the moment and keeps every option open, from the solid Queen\'s Gambit to the sharp King\'s Indian and Grünfeld.',
    w: 'It commits to nothing, so its strengths and weaknesses are those of whichever defence follows.',
  },
  'King\'s Indian Defense': {
    m: '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7',
    h: 'Considered dubious until the 1940s, when Soviet players such as Bronstein and Boleslavsky showed its power. Fischer and Kasparov made it their main fighting defence.',
    s: 'Black lets White have the centre and then strikes with ...e5 or ...c5; in the main lines Black gets a direct attack on the king with ...f5.',
    w: 'White gets a big space advantage and a strong queenside initiative; if Black\'s attack fails, the position is strategically lost.',
  },
  'King\'s Indian Defense: Sämisch Variation': {
    m: '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. f3',
    h: 'Named after the German master Friedrich Sämisch, who introduced it in the 1920s.',
    s: 'The f3 pawn makes the centre rock solid and prepares Be3, Qd2 and a pawn storm with g4 and h4.',
    w: 'The pawn takes the king\'s knight\'s best square and slows White\'s development, which gives Black time for ...c5 or a pawn sacrifice.',
  },
  'King\'s Indian Defense: Four Pawns Attack': {
    m: '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. f4',
    h: 'The most direct attempt to refute the King\'s Indian, tried since the 1920s.',
    s: 'White seizes the maximum space and threatens to roll Black up with e5.',
    w: 'The broad centre needs constant defence and is a ready target for ...c5 and ...e6; White can be left over-extended.',
  },
  'King\'s Indian Defense: Fianchetto Variation': {
    m: '1. d4 Nf6 2. c4 g6 3. Nf3 Bg7 4. g3',
    h: 'A favourite of positional players such as Botvinnik and later Karpov and Kramnik.',
    s: 'The bishop on g2 protects the king, so Black\'s usual kingside attack has nothing to bite on, while White keeps a small edge.',
    w: 'It puts less pressure on Black, who has several comfortable set-ups and less to fear.',
  },
  'King\'s Indian Defense: Orthodox Variation': {
    m: '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O 6. Be2 e5',
    h: 'The classical main line. Its Mar del Plata branch, named after a 1953 tournament, produced the famous races between White\'s queenside play and Black\'s kingside attack.',
    s: 'Both sides get exactly what they want: White space and queenside play, Black a pawn storm against the king.',
    w: 'The stakes are very high for both players, and the theory runs past move twenty in the critical lines.',
  },
  'Nimzo-Indian Defense': {
    m: '1. d4 Nf6 2. c4 e6 3. Nc3 Bb4',
    h: 'Introduced by Aron Nimzowitsch in the 1910s and 20s as a showcase of his ideas of restraint and blockade. It has been regarded as one of Black\'s best defences ever since.',
    s: 'Black controls e4 with pieces, develops fast and is ready to double White\'s c-pawns, getting a flexible position with no weaknesses.',
    w: 'Black usually has to give up the bishop pair, and in open positions White\'s two bishops can become strong.',
  },
  'Nimzo-Indian Defense: Classical Variation': {
    m: '1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Qc2',
    h: 'Popular with Capablanca in the 1920s and 30s and revived by Kasparov in the 1990s.',
    s: 'White avoids doubled pawns and prepares to take the bishop pair for free.',
    w: 'The queen moves early and White falls behind in development, which Black can use for active play in the centre.',
  },
  'Nimzo-Indian Defense: Sämisch Variation': {
    m: '1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. a3',
    h: 'Named after Friedrich Sämisch. Botvinnik\'s famous win over Capablanca at AVRO 1938 came from this pawn structure.',
    s: 'White forces the bishop to declare itself at once, gets the bishop pair and a big centre to push with f3 and e4.',
    w: 'White spends a move to accept doubled c-pawns; the pawn on c4 is a lasting target for ...Ba6 and ...Na5.',
  },
  'Queen\'s Indian Defense': {
    m: '1. d4 Nf6 2. c4 e6 3. Nf3 b6',
    h: 'Developed by Nimzowitsch and the hypermoderns in the 1920s as the companion to the Nimzo-Indian when White avoids 3. Nc3.',
    s: 'Black controls e4 from a distance with the bishop on b7 and reaches a sound, flexible position.',
    w: 'It is solid rather than ambitious; White keeps a little more space and Black has few winning chances.',
  },
  'Bogo-Indian Defense': {
    m: '1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+',
    h: 'Named after Efim Bogoljubov, who played it in the 1920s.',
    s: 'A simple, sound alternative to the Queen\'s Indian: Black develops with check and often trades the dark-squared bishops.',
    w: 'It is somewhat passive, and White keeps a small space advantage without risk.',
  },
  'Grünfeld Defense': {
    m: '1. d4 Nf6 2. c4 g6 3. Nc3 d5',
    h: 'Introduced by the Austrian master Ernst Grünfeld in 1922. It was a key weapon for Fischer and for Kasparov in his matches with Karpov.',
    s: 'Black lets White build a big centre and then attacks it with ...c5 and the bishop on g7, getting very active pieces.',
    w: 'If the centre holds and advances, Black can be overrun; the main lines require a great deal of concrete knowledge.',
  },
  'Grünfeld Defense: Exchange Variation': {
    m: '1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. cxd5 Nxd5 5. e4 Nxc3 6. bxc3',
    h: 'The principled test of the Grünfeld. Karpov used it against Kasparov in their world championship matches.',
    s: 'White gets the ideal pawn centre and chances to create a passed d-pawn.',
    w: 'The centre is under constant fire from ...c5, ...Nc6 and ...Bg4, and White\'s a- and c-pawns can become weak.',
  },
  'Neo-Grünfeld Defense': {
    m: '1. d4 Nf6 2. c4 g6 3. g3 d5',
    h: 'The Grünfeld idea played against a kingside fianchetto, common in top-level practice.',
    s: 'Black gets the usual Grünfeld activity; White\'s set-up is safe and the bishop on g2 eyes the centre.',
    w: 'Without a knight on c3 to take, Black\'s counterplay is slower, and the solid ...c6 lines can be dry.',
  },
  'Benoni Defense': {
    m: '1. d4 Nf6 2. c4 c5',
    h: 'The name comes from an 1825 book by Aaron Reinganum, "Ben-Oni" (Hebrew for "son of my sorrow"). Mikhail Tal made the Modern Benoni famous in the 1950s and 60s.',
    s: 'Black gets an unbalanced structure with a queenside pawn majority, the half-open e-file and a strong bishop on g7.',
    w: 'White has more space and a central majority; the advance e5 and the weak d6 pawn are constant dangers.',
  },
  'Benko Gambit': {
    m: '1. d4 Nf6 2. c4 c5 3. d5 b5',
    h: 'Named after the Hungarian-American grandmaster Pal Benko, who popularised it in the late 1960s. In Russian it is the Volga Gambit.',
    s: 'For a pawn Black gets lasting pressure down the a- and b-files and on the long diagonal, which persists even into the endgame.',
    w: 'It is a real pawn, and modern set-ups for White return it or neutralise the pressure, leaving Black with little.',
  },
  'Old Indian Defense': {
    m: '1. d4 Nf6 2. c4 d6',
    h: 'An older relative of the King\'s Indian, played by Chigorin and Tartakower.',
    s: 'Solid and simple, with ...e5 and the bishop developed on e7.',
    w: 'The bishop on e7 is passive compared with the King\'s Indian bishop, and Black has less counterplay.',
  },
  'Dutch Defense': {
    m: '1. d4 f5',
    h: 'Named after the Dutchman Elias Stein, who recommended it in 1789. Botvinnik used the Stonewall for years, and Alekhine and Bronstein played it in title matches.',
    s: 'Black takes control of e4 and gets an unbalanced game with kingside attacking chances from the first move.',
    w: 'The move weakens Black\'s own king and does nothing for development; gambits and early Bg5 lines can be awkward.',
  },
  'Dutch Defense: Leningrad Variation': {
    m: '1. d4 f5 2. g3 Nf6 3. Bg2 g6',
    h: 'Worked out by Leningrad players such as Korchnoi in the mid-twentieth century.',
    s: 'It combines the Dutch pawn with a King\'s Indian bishop; Black aims for ...e5 with dynamic play.',
    w: 'The e6 square and the diagonal to the king are weak, and White can hit the structure with d5 or b4.',
  },
  'Dutch Defense: Stonewall Variation': {
    m: '1. d4 f5 2. c4 Nf6 3. g3 e6 4. Bg2 d5',
    h: 'A favourite of Botvinnik; Magnus Carlsen has used it occasionally.',
    s: 'The pawns on c6, d5, e6 and f5 give Black a firm grip on e4 and a base for a kingside attack.',
    w: 'The e5 square is a permanent hole and the light-squared bishop is bad.',
  },
  'Budapest Gambit': {
    m: '1. d4 Nf6 2. c4 e5',
    h: 'Developed by Hungarian players in Budapest; Milan Vidmar used it to beat Rubinstein in Berlin in 1918.',
    s: 'Black gets quick, active piece play and a few traps for a pawn that is usually won back.',
    w: 'White can return the pawn for the bishop pair and a small, risk-free positional edge.',
  },
  'Indian Defense: Budapest Gambit': {
    m: '1. d4 Nf6 2. c4 e5',
    h: 'Developed by Hungarian players in Budapest; Milan Vidmar used it to beat Rubinstein in Berlin in 1918.',
    s: 'Black gets quick, active piece play and a few traps for a pawn that is usually won back.',
    w: 'White can return the pawn for the bishop pair and a small, risk-free positional edge.',
  },

  // --- flank openings ---
  'English Opening': {
    m: '1. c4',
    h: 'Named after the Englishman Howard Staunton, who played it against Saint-Amant in 1843. Botvinnik, Karpov and Kasparov all used it at the highest level.',
    s: 'Flexible: it controls d5 from the wing, can transpose to queen\'s pawn openings and gives White a Sicilian with an extra move after 1...e5.',
    w: 'It does not occupy the centre, so Black has a free choice of set-ups and can equalise with active play.',
  },
  'English Opening: Symmetrical Variation': {
    m: '1. c4 c5',
    h: 'A main line of the English at every level, with many branches including the Hedgehog, which came into fashion in the 1970s.',
    s: 'Black copies White\'s claim on the d-file squares and reaches a sound position with many transpositions.',
    w: 'White keeps the extra move, and breaking the symmetry safely can be hard for Black.',
  },
  'English Opening: King\'s English Variation': {
    m: '1. c4 e5',
    h: 'The Sicilian with colours reversed, a regular battleground in world championship matches including Kasparov–Karpov.',
    s: 'Black takes central space and develops freely; White has a Sicilian structure with a move in hand.',
    w: 'That extra move makes the sharpest Sicilian plans risky for Black, who usually has to play more modestly.',
  },
  'Réti Opening': {
    m: '1. Nf3 d5 2. c4',
    h: 'Named after Richard Réti, who beat world champion Capablanca with it in New York in 1924, ending Capablanca\'s eight-year unbeaten run.',
    s: 'A hypermodern system: White attacks the centre from the flanks, usually with a double fianchetto, and keeps many transpositions in hand.',
    w: 'Black can keep the pawn on d5 solidly or advance it to gain space, and equalises without great difficulty.',
  },
  'Zukertort Opening': {
    m: '1. Nf3',
    h: 'Named after Johannes Zukertort, Steinitz\'s rival in the first world championship match. Kramnik made 1. Nf3 a main weapon.',
    s: 'The most flexible first move: it stops ...e5 and can become a Réti, an English, a King\'s Indian Attack or a queen\'s pawn opening.',
    w: 'It makes no claim on the centre by itself, and rules out lines where White wants the f-pawn free.',
  },
  'King\'s Indian Attack': {
    m: '1. Nf3 d5 2. g3',
    h: 'The King\'s Indian set-up with an extra move. Bobby Fischer used it often, especially against the French and Sicilian.',
    s: 'A universal system needing little theory: Nf3, g3, Bg2, d3 and e4, often followed by a kingside attack.',
    w: 'It is slow and gives Black a free hand in the centre and on the queenside.',
  },
  'Bird Opening': {
    m: '1. f4',
    h: 'Named after the English master Henry Bird, who played it throughout the second half of the nineteenth century.',
    s: 'Controls e5 and gives a Dutch Defense with an extra move, with attacking chances on the kingside.',
    w: 'It weakens White\'s king, and From\'s Gambit (1...e5) is a sharp try that needs care.',
  },
  'Nimzo-Larsen Attack': {
    m: '1. b3',
    h: 'Played by Nimzowitsch and made famous by Bent Larsen in the 1960s and 70s. Fischer used it several times in 1970.',
    s: 'The bishop on b2 bears on the centre and kingside, and the game leaves known theory quickly.',
    w: 'Black can build a broad centre with ...e5 and ...d5 and blunt the bishop.',
  },
  'Polish Opening': {
    m: '1. b4',
    h: 'Also called the Sokolsky after Alexey Sokolsky, or the Orangutan: Tartakower played it in New York in 1924 after a visit to the zoo.',
    s: 'Gains queenside space and prepares Bb2 with surprise value.',
    w: 'The b-pawn is loose and can be attacked at once, and Black takes the centre for free.',
  },
  'Grob Opening': {
    m: '1. g4',
    h: 'Named after the Swiss master Henri Grob, who analysed it and played it in thousands of correspondence games. Michael Basman was its later champion.',
    s: 'It sets some traps on the long diagonal and takes the opponent out of the books immediately.',
    w: 'It seriously weakens White\'s kingside and is regarded as one of the worst first moves.',
  },
  'Hungarian Opening': {
    m: '1. g3',
    h: 'Also known as the Benko Opening after Pal Benko, who beat Fischer and Tal with it at the 1962 Candidates tournament.',
    s: 'A flexible fianchetto that can transpose to the Réti, the English, the Catalan or the King\'s Indian Attack.',
    w: 'It lets Black occupy the centre with whatever set-up Black likes.',
  },
  'Van Geet Opening': {
    m: '1. Nc3',
    h: 'Named after the Dutch master Dirk van Geet; also called the Dunst Opening.',
    s: 'Develops a piece and can transpose to the Vienna or to other e4 openings on White\'s terms.',
    w: 'The knight blocks the c-pawn, and Black can gain space with ...d5 and ...d4.',
  },
  'Van\'t Kruijs Opening': {
    m: '1. e3',
    h: 'Named after the Dutch player Maarten van\'t Kruijs, who won the Dutch championship in 1878.',
    s: 'It commits to very little and can transpose to several quiet systems.',
    w: 'Passive: it does not fight for the centre and shuts in the queen\'s bishop for no reason.',
  },
  'Bongcloud Attack': {
    m: '1. e4 e5 2. Ke2',
    h: 'An internet joke opening. Magnus Carlsen and Hikaru Nakamura famously played it against each other in an online tournament in 2021 and drew by repetition.',
    s: 'None, beyond the humour and the message it sends.',
    w: 'The king steps into the centre, blocks the bishop and queen, and gives up castling.',
  },

  // --- the broad names the book gives to the first moves ---
  'King\'s Pawn Game': {
    m: '1. e4',
    h: 'The most popular first move throughout chess history. Bobby Fischer called it "best by test".',
    s: 'It takes the centre and opens lines for the queen and king\'s bishop at once, which leads to open, tactical play.',
    w: 'The e4 pawn is undefended, so Black can attack it directly, and the sharpest replies need a lot of preparation.',
  },
  'King\'s Knight Opening': {
    m: '1. e4 e5 2. Nf3',
    h: 'The standard second move since the earliest printed chess books; nearly all the classical open games begin with it.',
    s: 'White develops a piece towards the centre and attacks e5 with gain of time.',
    w: 'It blocks the f-pawn, so the King\'s Gambit ideas are gone, and Black has several sound ways to defend or counter-attack.',
  },
  'Queen\'s Pawn Game': {
    m: '1. d4',
    h: 'Rare before the late nineteenth century, it became the main alternative to 1. e4 with the rise of positional play under Steinitz and his successors.',
    s: 'The d-pawn is protected by the queen, so White builds the centre safely and the game usually takes a slower, more strategic course.',
    w: 'It opens fewer lines for the pieces, and attacks take longer to arrange than after 1. e4.',
  },
  'Rapport-Jobava System': {
    m: '1. d4 d5 2. Nc3 Nf6 3. Bf4',
    h: 'Named after the grandmasters Richárd Rapport and Baadur Jobava, who made this once-obscure set-up popular in the 2010s.',
    s: 'A London System with the knight on c3: it brings quick ideas of Nb5 against c7 and an early e4, and catches unprepared opponents.',
    w: 'The knight blocks the c-pawn, so White cannot support the centre in the usual way, and ...c5 gives Black good play.',
  },
  'Blumenfeld Countergambit': {
    m: '1. d4 Nf6 2. c4 e6 3. Nf3 c5 4. d5 b5',
    h: 'Named after the Russian master Benjamin Blumenfeld. Alekhine made it famous by winning with it against Tarrasch at Bad Pistyan in 1922.',
    s: 'Black gives a wing pawn to destroy White\'s centre and build a mobile pawn mass with ...d5 and ...e5 ideas.',
    w: 'White can decline with 5. Bg5 and keep a small, safe advantage, which has kept the gambit from the mainstream.',
  },
  'English Defense': {
    m: '1. d4 e6 2. c4 b6',
    h: 'Developed in the 1970s by English players, among them Tony Miles, Raymond Keene and Michael Basman, which gave it its name.',
    s: 'Black aims the bishop at e4 and g2 and attacks White\'s centre with ...f5 and ...Bb4, leading to original positions.',
    w: 'White is allowed a full pawn centre with e4, and if it holds Black is short of space.',
  },
  'Rat Defense': {
    m: '1. d4 d6',
    h: 'A modern, flexible move order with no single inventor; it often turns into a Pirc, an Old Indian or a Philidor.',
    s: 'Black keeps White guessing and can aim for ...e5 at once, avoiding much of the main-line theory.',
    w: 'It concedes space, and the queen trade after 2. c4 e5 3. dxe5 leaves Black unable to castle.',
  },
};

// The family an opening belongs to when nothing else is known but its ECO
// code (a name from an engine or a PGN file that the book spells otherwise).
const ECO_FAMILIES = [
  ['A10', 'A39', 'English Opening'], ['A45', 'A45', 'Trompowsky Attack'], ['A51', 'A52', 'Budapest Gambit'],
  ['A57', 'A59', 'Benko Gambit'], ['A56', 'A79', 'Benoni Defense'], ['A80', 'A99', 'Dutch Defense'],
  ['B01', 'B01', 'Scandinavian Defense'], ['B02', 'B05', 'Alekhine Defense'], ['B06', 'B06', 'Modern Defense'],
  ['B07', 'B09', 'Pirc Defense'], ['B10', 'B19', 'Caro-Kann Defense'], ['B20', 'B99', 'Sicilian Defense'],
  ['C00', 'C19', 'French Defense'], ['C25', 'C29', 'Vienna Game'], ['C30', 'C39', 'King\'s Gambit'],
  ['C41', 'C41', 'Philidor Defense'], ['C42', 'C43', 'Petrov\'s Defense'], ['C45', 'C45', 'Scotch Game'],
  ['C46', 'C49', 'Four Knights Game'], ['C50', 'C59', 'Italian Game'], ['C60', 'C99', 'Ruy Lopez'],
  ['D10', 'D19', 'Slav Defense'], ['D20', 'D29', 'Queen\'s Gambit Accepted'], ['D43', 'D49', 'Semi-Slav Defense'],
  ['D30', 'D69', 'Queen\'s Gambit Declined'], ['D70', 'D99', 'Grünfeld Defense'], ['E00', 'E09', 'Catalan Opening'],
  ['E11', 'E11', 'Bogo-Indian Defense'], ['E12', 'E19', 'Queen\'s Indian Defense'], ['E20', 'E59', 'Nimzo-Indian Defense'],
  ['E60', 'E99', 'King\'s Indian Defense'],
];

// What the five volumes of the ECO cover, for openings with no write-up.
const ECO_VOLUMES = {
  A: 'Flank openings (1. c4, 1. Nf3, 1. f4 and others) and replies to 1. d4 other than 1...d5 and the main Indian defences.',
  B: 'Replies to 1. e4 other than 1...e5 and the French: the Sicilian, Caro-Kann, Pirc, Alekhine and Scandinavian.',
  C: 'The French Defense and the open games after 1. e4 e5.',
  D: 'The closed games after 1. d4 d5, and the Grünfeld Defense.',
  E: 'The Indian defences with ...e6 or ...g6: Catalan, Nimzo-Indian, Queen\'s Indian and King\'s Indian.',
};

// openingInfo finds the write-up for an opening as it is shown ("B90
// Sicilian Defense: Najdorf Variation, English Attack"): its own, or that
// of the nearest opening above it. It returns { eco, name, about, info },
// where about is the opening the write-up is for and info may be missing.
function openingInfo(text) {
  text = String(text ?? '').replace(/\s+/g, ' ').trim();
  const match = text.match(/^([A-E]\d\d)\b[\s:,-]*(.*)$/);
  const eco = match ? match[1] : '';
  const name = (match ? match[2] : text).trim();
  const plain = name.replace(/Defence/g, 'Defense').replace(/[’`]/g, '\'');
  let about = '';
  for (const key of Object.keys(OPENING_INFO)) {
    if (key.length <= about.length || !plain.startsWith(key)) continue;
    const next = plain[key.length];
    if (next === undefined || next === ':' || next === ',' || next === ' ') about = key;
  }
  if (!about && eco) {
    const range = ECO_FAMILIES.find(([from, to]) => eco >= from && eco <= to);
    if (range) about = range[2];
  }
  return { eco, name, about, info: about ? OPENING_INFO[about] : null };
}

// --- the card ---

const openingPop = { anchor: null, showTimer: null, hideTimer: null };

function fillOpeningPop(text) {
  const { eco, name, about, info } = openingInfo(text);
  const box = $('#opening-pop');
  const head = el('div', { className: 'op-head' }, [
    ...(eco ? [el('span', { className: 'op-eco', textContent: eco })] : []),
    el('span', { className: 'op-name', textContent: name || 'Opening' }),
  ]);
  if (!info) {
    box.replaceChildren(head,
      el('p', { className: 'op-none', textContent: 'There is no write-up for this opening yet.' }),
      ...(eco ? [el('p', { className: 'op-text', textContent: `${eco[0]} in the Encyclopaedia of Chess Openings: ${ECO_VOLUMES[eco[0]]}` })] : []));
    return;
  }
  const section = (cls, label, body) => el('div', { className: `op-section ${cls}` }, [
    el('span', { className: 'op-label', textContent: label }),
    el('p', { className: 'op-text', textContent: body }),
  ]);
  // A line deeper than the write-up: say which opening it is about.
  const broader = about !== name.replace(/Defence/g, 'Defense').replace(/[’`]/g, '\'');
  box.replaceChildren(
    head,
    ...(broader ? [el('p', { className: 'op-about', textContent: `A line of the ${about.replace(/^.*: /, '').replace(/^.*, /, '')}${about.includes(':') ? ` (${about.split(':')[0]})` : ''}.` })] : []),
    el('p', { className: 'op-moves', textContent: info.m }),
    section('history', 'History', info.h),
    section('plus', 'Strengths', info.s),
    section('minus', 'Weaknesses', info.w),
  );
}

function placeOpeningPop(anchor) {
  const box = $('#opening-pop');
  const r = anchor.getBoundingClientRect();
  const h = box.offsetHeight;
  const w = box.offsetWidth;
  const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
  const below = r.bottom + 6 + h <= innerHeight - 8 || r.top - 6 - h < 8;
  const top = below ? Math.min(r.bottom + 6, innerHeight - h - 8) : r.top - 6 - h;
  box.style.left = `${left}px`;
  box.style.top = `${Math.max(8, top)}px`;
}

function showOpeningPop(anchor) {
  const text = anchor.dataset.opening;
  if (!text || !anchor.isConnected) return;
  clearTimeout(openingPop.hideTimer);
  openingPop.anchor = anchor;
  fillOpeningPop(text);
  const box = $('#opening-pop');
  box.hidden = false;
  box.scrollTop = 0;
  placeOpeningPop(anchor);
}

function hideOpeningPop() {
  clearTimeout(openingPop.showTimer);
  clearTimeout(openingPop.hideTimer);
  openingPop.anchor = null;
  $('#opening-pop').hidden = true;
}

// Any element that names an opening carries it in data-opening; the card
// comes up after a moment of pointing at it, and stays while the pointer is
// on the card itself.
document.addEventListener('pointerover', (e) => {
  const anchor = e.target.closest?.('[data-opening]');
  if (!anchor || !anchor.dataset.opening) return;
  clearTimeout(openingPop.hideTimer);
  if (openingPop.anchor === anchor && !$('#opening-pop').hidden) return;
  clearTimeout(openingPop.showTimer);
  openingPop.showTimer = setTimeout(() => showOpeningPop(anchor), $('#opening-pop').hidden ? 350 : 80);
});
document.addEventListener('pointerout', (e) => {
  const anchor = e.target.closest?.('[data-opening]');
  if (!anchor || anchor.contains(e.relatedTarget)) return;
  clearTimeout(openingPop.showTimer);
  openingPop.hideTimer = setTimeout(hideOpeningPop, 250);
});
document.addEventListener('focusin', (e) => {
  if (e.target.matches?.('[data-opening]') && e.target.dataset.opening) showOpeningPop(e.target);
});
document.addEventListener('focusout', (e) => {
  if (e.target.matches?.('[data-opening]')) openingPop.hideTimer = setTimeout(hideOpeningPop, 250);
});
$('#opening-pop').addEventListener('pointerenter', () => clearTimeout(openingPop.hideTimer));
$('#opening-pop').addEventListener('pointerleave', () => { openingPop.hideTimer = setTimeout(hideOpeningPop, 250); });
document.addEventListener('pointerdown', (e) => {
  if (!$('#opening-pop').hidden && !e.target.closest('#opening-pop, [data-opening]')) hideOpeningPop();
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#opening-pop').hidden) hideOpeningPop(); });
window.addEventListener('resize', hideOpeningPop);
