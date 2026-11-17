/** Cites for the tests. GOOD ones are CardMirror's own reference
 *  examples (src/editor/ai/cite-creator.ts) — well-formed cites that
 *  must raise no error or warning. */
import type { PluginCard } from '@cardmirror/plugin-api';

export const TODAY = new Date(2026, 10, 17); // 11/17/2026

let n = 0;
export function card(cite: string, full: string | string[], over: Partial<PluginCard> = {}): PluginCard {
  n++;
  return {
    headingId: `h${n}`,
    kind: 'card',
    heading: `Tag ${n}`,
    cite,
    citeParagraphs: Array.isArray(full) ? full : [full],
    body: ['Body text.'],
    undertags: [],
    ...over,
  };
}

export const GOOD: { short: string; full: string }[] = [
  {
    short: 'Rose & Wilson 24',
    full: 'Adrien Rose & Christian Wilson 24, Rose is a research assistant in the Oxford Sustainable Finance Group, specializing in transition finance; Wilson is a DPhil student at the Smith School of Enterprise and the Environment (SSEE) and a Research Assistant in the Oxford Sustainable Finance Group, "Assessing the Credibility of Climate Transition Plans in the Oil and Gas Sector," Discussion Paper, Oxford Sustainable Finance Group, 09/23/2024, https://sustainablefinance.ox.ac.uk/wp-content/uploads/2024/09/SSEE-Discussion-Paper-Oil-Gas_final_AR.pdf',
  },
  {
    short: 'Felty & Yarrow 24',
    full: 'Keeff Felty & Grace Yarrow 24, Felty is President of the National Association of Wheat Growers; Yarrow is Food and Agriculture Policy Reporter at POLITICO, Author of POLITICO Pro\'s Morning Agriculture newsletter, University of Maryland graduate, "Ag groups hit the Hill," Politico, 9/9/24, https://www.politico.com/newsletters/weekly-agriculture/2024/09/09/ag-groups-hit-the-hill-00177896',
  },
  {
    short: 'Tuccille 23',
    full: 'J. D. Tuccille 23, Contributing Editor at Reason.com, former Managing Editor at Reason.com, columnist for Arizona Republic, Denver Post, and Washington Times, author of High Desert Barbecue, "It\'s Government Shutdown Theater, Again," Reason, 9/25/23, https://reason.com/2023/09/25/its-government-shutdown-theater-again/',
  },
  {
    short: 'Stavins 18',
    full: 'Robert N. Stavins 18, A.J. Meyer Professor of Energy and Economic Development, John F. Kennedy School of Government, Harvard University; University Fellow, Resources for the Future; and Research Associate, National Bureau of Economic Research, "Environmental Economics," The New Palgrave Dictionary of Economics, edited by Garett Jones, Third edition, Palgrave Macmillan, 2018, pp. 3782–3795',
  },
  {
    short: 'Parag & Darby 9',
    full: 'Yael Parag & Sarah Darby 9, Parag is the Vice Dean of Reichman University\'s School of Sustainability at Reichman University (IDC); Derby is BSc DPhil, Associate Professor, Energy Programme, Environmental Change Institute, University of Oxford, "Consumer–Supplier–Government Triangular Relations: Rethinking the UK Policy Path for Carbon Emissions Reduction from the UK Residential Sector," Energy Policy, vol. 37, no. 10, 10/01/2009, pp. 3984–3992',
  },
  {
    short: 'Jiang et al. 23',
    full: 'Jie Jiang et al. 23, Jie Jiang, School of Intellectual Property at Nanjing University of Science and Technology; Qihang Zhang, School of Intellectual Property at Nanjing University of Science and Technology; Yifan Hui, School of Mathematics and Statistics at University of Glasgow, "The Impact of Market and Non-Market-Based Environmental Policy Instruments on Firms\' Sustainable Technological Innovation: Evidence from Chinese Firms," Sustainability, vol. 15, no. 5, 5, Multidisciplinary Digital Publishing Institute, 01/15/2023, p. 4425',
  },
];
