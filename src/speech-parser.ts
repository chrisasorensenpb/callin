// Maps spoken words to digits
const wordToDigit: Record<string, string> = {
  'zero': '0',
  'oh': '0',
  'o': '0',
  'one': '1',
  'won': '1',
  'two': '2',
  'to': '2',
  'too': '2',
  'three': '3',
  'tree': '3',
  'four': '4',
  'for': '4',
  'fore': '4',
  'five': '5',
  'six': '6',
  'sicks': '6',
  'seven': '7',
  'eight': '8',
  'ate': '8',
  'ait': '8',
  'nine': '9',
  'niner': '9',
};

// Common digit variations and their numeric forms
const digitPatterns: [RegExp, string][] = [
  [/\bzero\b/gi, '0'],
  [/\boh\b/gi, '0'],
  [/\bone\b/gi, '1'],
  [/\bwon\b/gi, '1'],
  [/\btwo\b/gi, '2'],
  [/\bto\b/gi, '2'],
  [/\btoo\b/gi, '2'],
  [/\bthree\b/gi, '3'],
  [/\btree\b/gi, '3'],
  [/\bfour\b/gi, '4'],
  [/\bfor\b/gi, '4'],
  [/\bfore\b/gi, '4'],
  [/\bfive\b/gi, '5'],
  [/\bsix\b/gi, '6'],
  [/\bseven\b/gi, '7'],
  [/\beight\b/gi, '8'],
  [/\bate\b/gi, '8'],
  [/\bnine\b/gi, '9'],
  [/\bniner\b/gi, '9'],
];

export interface ParseResult {
  success: boolean;
  code?: string;
  rawInput: string;
  normalized?: string;
}

export function parseSpokenCode(speech: string): ParseResult {
  if (!speech || typeof speech !== 'string') {
    return { success: false, rawInput: speech || '' };
  }

  const rawInput = speech.trim();
  let normalized = rawInput.toLowerCase();

  // Remove common filler phrases
  normalized = normalized
    .replace(/\b(the\s+)?(code\s+is|my\s+code\s+is|it's|its|is)\b/gi, '')
    .replace(/\b(um|uh|like|so|yeah|okay|ok)\b/gi, '')
    .trim();

  // First, try to extract any 4-digit sequence directly
  const directDigits = normalized.replace(/\D/g, '');
  if (directDigits.length === 4) {
    return {
      success: true,
      code: directDigits,
      rawInput,
      normalized: directDigits,
    };
  }

  // Convert spoken words to digits
  let converted = normalized;
  for (const [pattern, digit] of digitPatterns) {
    converted = converted.replace(pattern, digit);
  }

  // Extract all digits
  const digits = converted.replace(/\D/g, '');

  if (digits.length === 4) {
    return {
      success: true,
      code: digits,
      rawInput,
      normalized: digits,
    };
  }

  // Handle compound numbers (e.g., "forty eight twenty seven" for 4827)
  const compoundResult = parseCompoundNumbers(normalized);
  if (compoundResult && compoundResult.length === 4) {
    return {
      success: true,
      code: compoundResult,
      rawInput,
      normalized: compoundResult,
    };
  }

  // If we have more than 4 digits, try to find a 4-digit sequence
  if (digits.length > 4) {
    // Take the first 4 digits
    return {
      success: true,
      code: digits.slice(0, 4),
      rawInput,
      normalized: digits.slice(0, 4),
    };
  }

  return {
    success: false,
    rawInput,
    normalized: digits || undefined,
  };
}

function parseCompoundNumbers(text: string): string | null {
  const compounds: Record<string, string> = {
    'ten': '10',
    'eleven': '11',
    'twelve': '12',
    'thirteen': '13',
    'fourteen': '14',
    'fifteen': '15',
    'sixteen': '16',
    'seventeen': '17',
    'eighteen': '18',
    'nineteen': '19',
    'twenty': '20',
    'thirty': '30',
    'forty': '40',
    'fifty': '50',
    'sixty': '60',
    'seventy': '70',
    'eighty': '80',
    'ninety': '90',
  };

  let result = text;

  // Replace compound numbers
  for (const [word, num] of Object.entries(compounds)) {
    result = result.replace(new RegExp(`\\b${word}\\b`, 'gi'), num);
  }

  // Handle "forty eight" -> "48"
  result = result.replace(/(\d)0\s*(\d)/g, (_, tens, ones) => `${tens}${ones}`);

  // Extract digits
  const digits = result.replace(/\D/g, '');

  return digits.length >= 4 ? digits : null;
}

export function sanitizeName(speech: string): string {
  if (!speech || typeof speech !== 'string') {
    return '';
  }

  // Remove common filler words and normalize
  let name = speech.trim()
    .replace(/\b(my name is|i'm|i am|it's|this is|call me)\b/gi, '')
    .replace(/\b(um|uh|like|so|yeah)\b/gi, '')
    .trim();

  // Capitalize first letter of each word
  name = name
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');

  // Limit length and remove special characters
  name = name.replace(/[^a-zA-Z\s'-]/g, '').slice(0, 100);

  return name || 'Caller';
}

export function parseVerticalSelection(speech: string): string | null {
  const input = speech.toLowerCase().trim();

  const verticals: Record<string, string[]> = {
    'real_estate': ['real estate', 'realestate', 'real-estate', 'property', 'properties', 'realtor'],
    'insurance': ['insurance', 'insure', 'policy', 'policies'],
    'mortgage': ['mortgage', 'loan', 'loans', 'lending', 'home loan'],
    'other': ['other', 'something else', 'different', 'none'],
  };

  for (const [key, keywords] of Object.entries(verticals)) {
    for (const keyword of keywords) {
      if (input.includes(keyword)) {
        return key;
      }
    }
  }

  return null;
}

export function parsePainSelection(speech: string): string | null {
  const input = speech.toLowerCase().trim();

  const pains: Record<string, string[]> = {
    'spam_flags': ['spam', 'flag', 'flagged', 'blocked', 'scam likely', 'spam likely'],
    'awkward_delay': ['awkward', 'delay', 'pause', 'waiting', 'silence', 'dead air'],
    'low_answer_rates': ['answer', 'rate', 'rates', 'low answer', 'nobody answers', 'pickup'],
    'speed': ['speed', 'slow', 'fast', 'quick', 'efficiency', 'time'],
  };

  for (const [key, keywords] of Object.entries(pains)) {
    for (const keyword of keywords) {
      if (input.includes(keyword)) {
        return key;
      }
    }
  }

  return null;
}

export interface PhoneParseResult {
  success: boolean;
  number?: string;
  rawInput: string;
}

export function parsePhoneNumber(speech: string): PhoneParseResult {
  if (!speech || typeof speech !== 'string') {
    return { success: false, rawInput: speech || '' };
  }

  const rawInput = speech.trim();
  let normalized = rawInput.toLowerCase();

  // Remove common filler phrases
  normalized = normalized
    .replace(/\b(my number is|my phone number is|it's|the number is|call me at)\b/gi, '')
    .replace(/\b(um|uh|like|so|yeah|okay|ok)\b/gi, '')
    .trim();

  // Convert spoken words to digits
  let converted = normalized;
  for (const [pattern, digit] of digitPatterns) {
    converted = converted.replace(pattern, digit);
  }

  // Extract all digits
  const digits = converted.replace(/\D/g, '');

  // Valid US phone number formats
  if (digits.length === 10) {
    return {
      success: true,
      number: `+1${digits}`,
      rawInput,
    };
  }

  if (digits.length === 11 && digits[0] === '1') {
    return {
      success: true,
      number: `+${digits}`,
      rawInput,
    };
  }

  // If we have more than 10 digits, take the last 10
  if (digits.length > 10) {
    const lastTen = digits.slice(-10);
    return {
      success: true,
      number: `+1${lastTen}`,
      rawInput,
    };
  }

  return {
    success: false,
    rawInput,
  };
}
