import { parseCSVLines, sanitizeText } from './excelQuizParser'

const csv = `Question,Choice 1,Choice 2,Choice 3,Choice 4
What happens to excess dietary protein beyond the body's growth and repair needs?,Stored in muscles for future use,+Converted to glucose or fat for energy/storage,Excreted completely intact in feces,Directly converted into essential amino acids`

// Let's test parseCSVLines on this:
const rows = csv.split('\n').map(l => l.split(','))
console.log('Split rows:', rows)
