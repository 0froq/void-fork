import { AutocompletePrompt, CANCEL_SYMBOL, ConfirmPrompt, GroupMultiSelectPrompt, MultiSelectPrompt, PasswordPrompt, SelectKeyPrompt, SelectPrompt, TextPrompt, block, getColumns, getRows, isAccessible, isCancel, isCancel as isCancel$1, runValidation, settings, settings as settings$1, updateSettings, updateSettings as updateSettings$1 } from "@clack/core";
import color from "picocolors";
import process$1 from "node:process";
import { stripVTControlCharacters } from "node:util";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { cursor, erase } from "sisteransi";
//#region ../../../../../../private/tmp/void-prompts-spacing-tools/node_modules/fast-string-truncated-width/dist/utils.js
const isAmbiguous = (x) => {
	return x === 161 || x === 164 || x === 167 || x === 168 || x === 170 || x === 173 || x === 174 || x >= 176 && x <= 180 || x >= 182 && x <= 186 || x >= 188 && x <= 191 || x === 198 || x === 208 || x === 215 || x === 216 || x >= 222 && x <= 225 || x === 230 || x >= 232 && x <= 234 || x === 236 || x === 237 || x === 240 || x === 242 || x === 243 || x >= 247 && x <= 250 || x === 252 || x === 254 || x === 257 || x === 273 || x === 275 || x === 283 || x === 294 || x === 295 || x === 299 || x >= 305 && x <= 307 || x === 312 || x >= 319 && x <= 322 || x === 324 || x >= 328 && x <= 331 || x === 333 || x === 338 || x === 339 || x === 358 || x === 359 || x === 363 || x === 462 || x === 464 || x === 466 || x === 468 || x === 470 || x === 472 || x === 474 || x === 476 || x === 593 || x === 609 || x === 708 || x === 711 || x >= 713 && x <= 715 || x === 717 || x === 720 || x >= 728 && x <= 731 || x === 733 || x === 735 || x >= 768 && x <= 879 || x >= 913 && x <= 929 || x >= 931 && x <= 937 || x >= 945 && x <= 961 || x >= 963 && x <= 969 || x === 1025 || x >= 1040 && x <= 1103 || x === 1105 || x === 8208 || x >= 8211 && x <= 8214 || x === 8216 || x === 8217 || x === 8220 || x === 8221 || x >= 8224 && x <= 8226 || x >= 8228 && x <= 8231 || x === 8240 || x === 8242 || x === 8243 || x === 8245 || x === 8251 || x === 8254 || x === 8308 || x === 8319 || x >= 8321 && x <= 8324 || x === 8364 || x === 8451 || x === 8453 || x === 8457 || x === 8467 || x === 8470 || x === 8481 || x === 8482 || x === 8486 || x === 8491 || x === 8531 || x === 8532 || x >= 8539 && x <= 8542 || x >= 8544 && x <= 8555 || x >= 8560 && x <= 8569 || x === 8585 || x >= 8592 && x <= 8601 || x === 8632 || x === 8633 || x === 8658 || x === 8660 || x === 8679 || x === 8704 || x === 8706 || x === 8707 || x === 8711 || x === 8712 || x === 8715 || x === 8719 || x === 8721 || x === 8725 || x === 8730 || x >= 8733 && x <= 8736 || x === 8739 || x === 8741 || x >= 8743 && x <= 8748 || x === 8750 || x >= 8756 && x <= 8759 || x === 8764 || x === 8765 || x === 8776 || x === 8780 || x === 8786 || x === 8800 || x === 8801 || x >= 8804 && x <= 8807 || x === 8810 || x === 8811 || x === 8814 || x === 8815 || x === 8834 || x === 8835 || x === 8838 || x === 8839 || x === 8853 || x === 8857 || x === 8869 || x === 8895 || x === 8978 || x >= 9312 && x <= 9449 || x >= 9451 && x <= 9547 || x >= 9552 && x <= 9587 || x >= 9600 && x <= 9615 || x >= 9618 && x <= 9621 || x === 9632 || x === 9633 || x >= 9635 && x <= 9641 || x === 9650 || x === 9651 || x === 9654 || x === 9655 || x === 9660 || x === 9661 || x === 9664 || x === 9665 || x >= 9670 && x <= 9672 || x === 9675 || x >= 9678 && x <= 9681 || x >= 9698 && x <= 9701 || x === 9711 || x === 9733 || x === 9734 || x === 9737 || x === 9742 || x === 9743 || x === 9756 || x === 9758 || x === 9792 || x === 9794 || x === 9824 || x === 9825 || x >= 9827 && x <= 9829 || x >= 9831 && x <= 9834 || x === 9836 || x === 9837 || x === 9839 || x === 9886 || x === 9887 || x === 9919 || x >= 9926 && x <= 9933 || x >= 9935 && x <= 9939 || x >= 9941 && x <= 9953 || x === 9955 || x === 9960 || x === 9961 || x >= 9963 && x <= 9969 || x === 9972 || x >= 9974 && x <= 9977 || x === 9979 || x === 9980 || x === 9982 || x === 9983 || x === 10045 || x >= 10102 && x <= 10111 || x >= 11094 && x <= 11097 || x >= 12872 && x <= 12879 || x >= 57344 && x <= 63743 || x >= 65024 && x <= 65039 || x === 65533 || x >= 127232 && x <= 127242 || x >= 127248 && x <= 127277 || x >= 127280 && x <= 127337 || x >= 127344 && x <= 127373 || x === 127375 || x === 127376 || x >= 127387 && x <= 127404 || x >= 917760 && x <= 917999 || x >= 983040 && x <= 1048573 || x >= 1048576 && x <= 1114109;
};
const isFullWidth$1 = (x) => {
	return x === 12288 || x >= 65281 && x <= 65376 || x >= 65504 && x <= 65510;
};
const isWide = (x) => {
	return x >= 4352 && x <= 4447 || x === 8986 || x === 8987 || x === 9001 || x === 9002 || x >= 9193 && x <= 9196 || x === 9200 || x === 9203 || x === 9725 || x === 9726 || x === 9748 || x === 9749 || x >= 9800 && x <= 9811 || x === 9855 || x === 9875 || x === 9889 || x === 9898 || x === 9899 || x === 9917 || x === 9918 || x === 9924 || x === 9925 || x === 9934 || x === 9940 || x === 9962 || x === 9970 || x === 9971 || x === 9973 || x === 9978 || x === 9981 || x === 9989 || x === 9994 || x === 9995 || x === 10024 || x === 10060 || x === 10062 || x >= 10067 && x <= 10069 || x === 10071 || x >= 10133 && x <= 10135 || x === 10160 || x === 10175 || x === 11035 || x === 11036 || x === 11088 || x === 11093 || x >= 11904 && x <= 11929 || x >= 11931 && x <= 12019 || x >= 12032 && x <= 12245 || x >= 12272 && x <= 12287 || x >= 12289 && x <= 12350 || x >= 12353 && x <= 12438 || x >= 12441 && x <= 12543 || x >= 12549 && x <= 12591 || x >= 12593 && x <= 12686 || x >= 12688 && x <= 12771 || x >= 12783 && x <= 12830 || x >= 12832 && x <= 12871 || x >= 12880 && x <= 19903 || x >= 19968 && x <= 42124 || x >= 42128 && x <= 42182 || x >= 43360 && x <= 43388 || x >= 44032 && x <= 55203 || x >= 63744 && x <= 64255 || x >= 65040 && x <= 65049 || x >= 65072 && x <= 65106 || x >= 65108 && x <= 65126 || x >= 65128 && x <= 65131 || x >= 94176 && x <= 94180 || x === 94192 || x === 94193 || x >= 94208 && x <= 100343 || x >= 100352 && x <= 101589 || x >= 101632 && x <= 101640 || x >= 110576 && x <= 110579 || x >= 110581 && x <= 110587 || x === 110589 || x === 110590 || x >= 110592 && x <= 110882 || x === 110898 || x >= 110928 && x <= 110930 || x === 110933 || x >= 110948 && x <= 110951 || x >= 110960 && x <= 111355 || x === 126980 || x === 127183 || x === 127374 || x >= 127377 && x <= 127386 || x >= 127488 && x <= 127490 || x >= 127504 && x <= 127547 || x >= 127552 && x <= 127560 || x === 127568 || x === 127569 || x >= 127584 && x <= 127589 || x >= 127744 && x <= 127776 || x >= 127789 && x <= 127797 || x >= 127799 && x <= 127868 || x >= 127870 && x <= 127891 || x >= 127904 && x <= 127946 || x >= 127951 && x <= 127955 || x >= 127968 && x <= 127984 || x === 127988 || x >= 127992 && x <= 128062 || x === 128064 || x >= 128066 && x <= 128252 || x >= 128255 && x <= 128317 || x >= 128331 && x <= 128334 || x >= 128336 && x <= 128359 || x === 128378 || x === 128405 || x === 128406 || x === 128420 || x >= 128507 && x <= 128591 || x >= 128640 && x <= 128709 || x === 128716 || x >= 128720 && x <= 128722 || x >= 128725 && x <= 128727 || x >= 128732 && x <= 128735 || x === 128747 || x === 128748 || x >= 128756 && x <= 128764 || x >= 128992 && x <= 129003 || x === 129008 || x >= 129292 && x <= 129338 || x >= 129340 && x <= 129349 || x >= 129351 && x <= 129535 || x >= 129648 && x <= 129660 || x >= 129664 && x <= 129672 || x >= 129680 && x <= 129725 || x >= 129727 && x <= 129733 || x >= 129742 && x <= 129755 || x >= 129760 && x <= 129768 || x >= 129776 && x <= 129784 || x >= 131072 && x <= 196605 || x >= 196608 && x <= 262141;
};
//#endregion
//#region ../../../../../../private/tmp/void-prompts-spacing-tools/node_modules/fast-string-truncated-width/dist/index.js
const ANSI_RE$1 = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/y;
const CONTROL_RE$1 = /[\x00-\x08\x0A-\x1F\x7F-\x9F]{1,1000}/y;
const TAB_RE$1 = /\t{1,1000}/y;
const EMOJI_RE$1 = /[\u{1F1E6}-\u{1F1FF}]{2}|\u{1F3F4}[\u{E0061}-\u{E007A}]{2}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,3}\u{E007F}|(?:\p{Emoji}\uFE0F\u20E3?|\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?|\p{Emoji_Presentation})(?:\u200D(?:\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?|\p{Emoji_Presentation}|\p{Emoji}\uFE0F\u20E3?))*/uy;
const LATIN_RE$1 = /(?:[\x20-\x7E\xA0-\xFF](?!\uFE0F)){1,1000}/y;
const MODIFIER_RE$1 = /\p{M}+/gu;
const NO_TRUNCATION$3 = {
	limit: Infinity,
	ellipsis: ""
};
const getStringTruncatedWidth$1 = (input, truncationOptions = {}, widthOptions = {}) => {
	const LIMIT = truncationOptions.limit ?? Infinity;
	const ELLIPSIS = truncationOptions.ellipsis ?? "";
	const ELLIPSIS_WIDTH = truncationOptions?.ellipsisWidth ?? (ELLIPSIS ? getStringTruncatedWidth$1(ELLIPSIS, NO_TRUNCATION$3, widthOptions).width : 0);
	const ANSI_WIDTH = widthOptions.ansiWidth ?? 0;
	const CONTROL_WIDTH = widthOptions.controlWidth ?? 0;
	const TAB_WIDTH = widthOptions.tabWidth ?? 8;
	const AMBIGUOUS_WIDTH = widthOptions.ambiguousWidth ?? 1;
	const EMOJI_WIDTH = widthOptions.emojiWidth ?? 2;
	const FULL_WIDTH_WIDTH = widthOptions.fullWidthWidth ?? 2;
	const REGULAR_WIDTH = widthOptions.regularWidth ?? 1;
	const WIDE_WIDTH = widthOptions.wideWidth ?? 2;
	let indexPrev = 0;
	let index = 0;
	let length = input.length;
	let lengthExtra = 0;
	let truncationEnabled = false;
	let truncationIndex = length;
	let truncationLimit = Math.max(0, LIMIT - ELLIPSIS_WIDTH);
	let unmatchedStart = 0;
	let unmatchedEnd = 0;
	let width = 0;
	let widthExtra = 0;
	outer: while (true) {
		if (unmatchedEnd > unmatchedStart || index >= length && index > indexPrev) {
			const unmatched = input.slice(unmatchedStart, unmatchedEnd) || input.slice(indexPrev, index);
			lengthExtra = 0;
			for (const char of unmatched.replaceAll(MODIFIER_RE$1, "")) {
				const codePoint = char.codePointAt(0) || 0;
				if (isFullWidth$1(codePoint)) widthExtra = FULL_WIDTH_WIDTH;
				else if (isWide(codePoint)) widthExtra = WIDE_WIDTH;
				else if (AMBIGUOUS_WIDTH !== REGULAR_WIDTH && isAmbiguous(codePoint)) widthExtra = AMBIGUOUS_WIDTH;
				else widthExtra = REGULAR_WIDTH;
				if (width + widthExtra > truncationLimit) truncationIndex = Math.min(truncationIndex, Math.max(unmatchedStart, indexPrev) + lengthExtra);
				if (width + widthExtra > LIMIT) {
					truncationEnabled = true;
					break outer;
				}
				lengthExtra += char.length;
				width += widthExtra;
			}
			unmatchedStart = unmatchedEnd = 0;
		}
		if (index >= length) break;
		LATIN_RE$1.lastIndex = index;
		if (LATIN_RE$1.test(input)) {
			lengthExtra = LATIN_RE$1.lastIndex - index;
			widthExtra = lengthExtra * REGULAR_WIDTH;
			if (width + widthExtra > truncationLimit) truncationIndex = Math.min(truncationIndex, index + Math.floor((truncationLimit - width) / REGULAR_WIDTH));
			if (width + widthExtra > LIMIT) {
				truncationEnabled = true;
				break;
			}
			width += widthExtra;
			unmatchedStart = indexPrev;
			unmatchedEnd = index;
			index = indexPrev = LATIN_RE$1.lastIndex;
			continue;
		}
		ANSI_RE$1.lastIndex = index;
		if (ANSI_RE$1.test(input)) {
			if (width + ANSI_WIDTH > truncationLimit) truncationIndex = Math.min(truncationIndex, index);
			if (width + ANSI_WIDTH > LIMIT) {
				truncationEnabled = true;
				break;
			}
			width += ANSI_WIDTH;
			unmatchedStart = indexPrev;
			unmatchedEnd = index;
			index = indexPrev = ANSI_RE$1.lastIndex;
			continue;
		}
		CONTROL_RE$1.lastIndex = index;
		if (CONTROL_RE$1.test(input)) {
			lengthExtra = CONTROL_RE$1.lastIndex - index;
			widthExtra = lengthExtra * CONTROL_WIDTH;
			if (width + widthExtra > truncationLimit) truncationIndex = Math.min(truncationIndex, index + Math.floor((truncationLimit - width) / CONTROL_WIDTH));
			if (width + widthExtra > LIMIT) {
				truncationEnabled = true;
				break;
			}
			width += widthExtra;
			unmatchedStart = indexPrev;
			unmatchedEnd = index;
			index = indexPrev = CONTROL_RE$1.lastIndex;
			continue;
		}
		TAB_RE$1.lastIndex = index;
		if (TAB_RE$1.test(input)) {
			lengthExtra = TAB_RE$1.lastIndex - index;
			widthExtra = lengthExtra * TAB_WIDTH;
			if (width + widthExtra > truncationLimit) truncationIndex = Math.min(truncationIndex, index + Math.floor((truncationLimit - width) / TAB_WIDTH));
			if (width + widthExtra > LIMIT) {
				truncationEnabled = true;
				break;
			}
			width += widthExtra;
			unmatchedStart = indexPrev;
			unmatchedEnd = index;
			index = indexPrev = TAB_RE$1.lastIndex;
			continue;
		}
		EMOJI_RE$1.lastIndex = index;
		if (EMOJI_RE$1.test(input)) {
			if (width + EMOJI_WIDTH > truncationLimit) truncationIndex = Math.min(truncationIndex, index);
			if (width + EMOJI_WIDTH > LIMIT) {
				truncationEnabled = true;
				break;
			}
			width += EMOJI_WIDTH;
			unmatchedStart = indexPrev;
			unmatchedEnd = index;
			index = indexPrev = EMOJI_RE$1.lastIndex;
			continue;
		}
		index += 1;
	}
	return {
		width: truncationEnabled ? truncationLimit : width,
		index: truncationEnabled ? truncationIndex : length,
		truncated: truncationEnabled,
		ellipsed: truncationEnabled && LIMIT >= ELLIPSIS_WIDTH
	};
};
//#endregion
//#region ../../../../../../private/tmp/void-prompts-spacing-tools/node_modules/fast-string-width/dist/index.js
const NO_TRUNCATION$2 = {
	limit: Infinity,
	ellipsis: "",
	ellipsisWidth: 0
};
const fastStringWidth$1 = (input, options = {}) => {
	return getStringTruncatedWidth$1(input, NO_TRUNCATION$2, options).width;
};
//#endregion
//#region ../../../../../../private/tmp/void-prompts-spacing-tools/node_modules/fast-wrap-ansi/node_modules/fast-string-truncated-width/dist/utils.js
const getCodePointsLength = (() => {
	const SURROGATE_PAIR_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
	return (input) => {
		let surrogatePairsNr = 0;
		SURROGATE_PAIR_RE.lastIndex = 0;
		while (SURROGATE_PAIR_RE.test(input)) surrogatePairsNr += 1;
		return input.length - surrogatePairsNr;
	};
})();
const isFullWidth = (x) => {
	return x === 12288 || x >= 65281 && x <= 65376 || x >= 65504 && x <= 65510;
};
const isWideNotCJKTNotEmoji = (x) => {
	return x === 8987 || x === 9001 || x >= 12272 && x <= 12287 || x >= 12289 && x <= 12350 || x >= 12441 && x <= 12543 || x >= 12549 && x <= 12591 || x >= 12593 && x <= 12686 || x >= 12688 && x <= 12771 || x >= 12783 && x <= 12830 || x >= 12832 && x <= 12871 || x >= 12880 && x <= 19903 || x >= 65040 && x <= 65049 || x >= 65072 && x <= 65106 || x >= 65108 && x <= 65126 || x >= 65128 && x <= 65131 || x >= 127488 && x <= 127490 || x >= 127504 && x <= 127547 || x >= 127552 && x <= 127560 || x >= 131072 && x <= 196605 || x >= 196608 && x <= 262141;
};
//#endregion
//#region ../../../../../../private/tmp/void-prompts-spacing-tools/node_modules/fast-wrap-ansi/node_modules/fast-string-truncated-width/dist/index.js
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|\u001b\]8;[^;]*;.*?(?:\u0007|\u001b\u005c)/y;
const CONTROL_RE = /[\x00-\x08\x0A-\x1F\x7F-\x9F]{1,1000}/y;
const CJKT_WIDE_RE = /(?:(?![\uFF61-\uFF9F\uFF00-\uFFEF])[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Tangut}]){1,1000}/uy;
const TAB_RE = /\t{1,1000}/y;
const EMOJI_RE = /[\u{1F1E6}-\u{1F1FF}]{2}|\u{1F3F4}[\u{E0061}-\u{E007A}]{2}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,3}\u{E007F}|(?:\p{Emoji}\uFE0F\u20E3?|\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?|\p{Emoji_Presentation})(?:\u200D(?:\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?|\p{Emoji_Presentation}|\p{Emoji}\uFE0F\u20E3?))*/uy;
const LATIN_RE = /(?:[\x20-\x7E\xA0-\xFF](?!\uFE0F)){1,1000}/y;
const MODIFIER_RE = /\p{M}+/gu;
const NO_TRUNCATION$1 = {
	limit: Infinity,
	ellipsis: ""
};
const getStringTruncatedWidth = (input, truncationOptions = {}, widthOptions = {}) => {
	const LIMIT = truncationOptions.limit ?? Infinity;
	const ELLIPSIS = truncationOptions.ellipsis ?? "";
	const ELLIPSIS_WIDTH = truncationOptions?.ellipsisWidth ?? (ELLIPSIS ? getStringTruncatedWidth(ELLIPSIS, NO_TRUNCATION$1, widthOptions).width : 0);
	const ANSI_WIDTH = 0;
	const CONTROL_WIDTH = widthOptions.controlWidth ?? 0;
	const TAB_WIDTH = widthOptions.tabWidth ?? 8;
	const EMOJI_WIDTH = widthOptions.emojiWidth ?? 2;
	const FULL_WIDTH_WIDTH = 2;
	const REGULAR_WIDTH = widthOptions.regularWidth ?? 1;
	const WIDE_WIDTH = widthOptions.wideWidth ?? FULL_WIDTH_WIDTH;
	const PARSE_BLOCKS = [
		[LATIN_RE, REGULAR_WIDTH],
		[ANSI_RE, ANSI_WIDTH],
		[CONTROL_RE, CONTROL_WIDTH],
		[TAB_RE, TAB_WIDTH],
		[EMOJI_RE, EMOJI_WIDTH],
		[CJKT_WIDE_RE, WIDE_WIDTH]
	];
	let indexPrev = 0;
	let index = 0;
	let length = input.length;
	let lengthExtra = 0;
	let truncationEnabled = false;
	let truncationIndex = length;
	let truncationLimit = Math.max(0, LIMIT - ELLIPSIS_WIDTH);
	let unmatchedStart = 0;
	let unmatchedEnd = 0;
	let width = 0;
	let widthExtra = 0;
	outer: while (true) {
		if (unmatchedEnd > unmatchedStart || index >= length && index > indexPrev) {
			const unmatched = input.slice(unmatchedStart, unmatchedEnd) || input.slice(indexPrev, index);
			lengthExtra = 0;
			for (const char of unmatched.replaceAll(MODIFIER_RE, "")) {
				const codePoint = char.codePointAt(0) || 0;
				if (isFullWidth(codePoint)) widthExtra = FULL_WIDTH_WIDTH;
				else if (isWideNotCJKTNotEmoji(codePoint)) widthExtra = WIDE_WIDTH;
				else widthExtra = REGULAR_WIDTH;
				if (width + widthExtra > truncationLimit) truncationIndex = Math.min(truncationIndex, Math.max(unmatchedStart, indexPrev) + lengthExtra);
				if (width + widthExtra > LIMIT) {
					truncationEnabled = true;
					break outer;
				}
				lengthExtra += char.length;
				width += widthExtra;
			}
			unmatchedStart = unmatchedEnd = 0;
		}
		if (index >= length) break outer;
		for (let i = 0, l = PARSE_BLOCKS.length; i < l; i++) {
			const [BLOCK_RE, BLOCK_WIDTH] = PARSE_BLOCKS[i];
			BLOCK_RE.lastIndex = index;
			if (BLOCK_RE.test(input)) {
				lengthExtra = BLOCK_RE === CJKT_WIDE_RE ? getCodePointsLength(input.slice(index, BLOCK_RE.lastIndex)) : BLOCK_RE === EMOJI_RE ? 1 : BLOCK_RE.lastIndex - index;
				widthExtra = lengthExtra * BLOCK_WIDTH;
				if (width + widthExtra > truncationLimit) truncationIndex = Math.min(truncationIndex, index + Math.floor((truncationLimit - width) / BLOCK_WIDTH));
				if (width + widthExtra > LIMIT) {
					truncationEnabled = true;
					break outer;
				}
				width += widthExtra;
				unmatchedStart = indexPrev;
				unmatchedEnd = index;
				index = indexPrev = BLOCK_RE.lastIndex;
				continue outer;
			}
		}
		index += 1;
	}
	return {
		width: truncationEnabled ? truncationLimit : width,
		index: truncationEnabled ? truncationIndex : length,
		truncated: truncationEnabled,
		ellipsed: truncationEnabled && LIMIT >= ELLIPSIS_WIDTH
	};
};
//#endregion
//#region ../../../../../../private/tmp/void-prompts-spacing-tools/node_modules/fast-wrap-ansi/node_modules/fast-string-width/dist/index.js
const NO_TRUNCATION = {
	limit: Infinity,
	ellipsis: "",
	ellipsisWidth: 0
};
const fastStringWidth = (input, options = {}) => {
	return getStringTruncatedWidth(input, NO_TRUNCATION, options).width;
};
//#endregion
//#region ../../../../../../private/tmp/void-prompts-spacing-tools/node_modules/fast-wrap-ansi/lib/main.js
const ESC = "\x1B";
const CSI = "";
const END_CODE = 39;
const ANSI_ESCAPE_BELL = "\x07";
const ANSI_CSI = "[";
const ANSI_OSC = "]";
const ANSI_SGR_TERMINATOR = "m";
const ANSI_ESCAPE_LINK = `${ANSI_OSC}8;;`;
const GROUP_REGEX = new RegExp(`(?:\\${ANSI_CSI}(?<code>\\d+)m|\\${ANSI_ESCAPE_LINK}(?<uri>.*)${ANSI_ESCAPE_BELL})`, "y");
const getClosingCode = (openingCode) => {
	if (openingCode >= 30 && openingCode <= 37) return 39;
	if (openingCode >= 90 && openingCode <= 97) return 39;
	if (openingCode >= 40 && openingCode <= 47) return 49;
	if (openingCode >= 100 && openingCode <= 107) return 49;
	if (openingCode === 1 || openingCode === 2) return 22;
	if (openingCode === 3) return 23;
	if (openingCode === 4) return 24;
	if (openingCode === 7) return 27;
	if (openingCode === 8) return 28;
	if (openingCode === 9) return 29;
	if (openingCode === 0) return 0;
};
const wrapAnsiCode = (code) => `${ESC}${ANSI_CSI}${code}${ANSI_SGR_TERMINATOR}`;
const wrapAnsiHyperlink = (url) => `${ESC}${ANSI_ESCAPE_LINK}${url}${ANSI_ESCAPE_BELL}`;
const wrapWord = (rows, word, columns) => {
	const characters = word[Symbol.iterator]();
	let isInsideEscape = false;
	let isInsideLinkEscape = false;
	let lastRow = rows.at(-1);
	let visible = lastRow === void 0 ? 0 : fastStringWidth(lastRow);
	let currentCharacter = characters.next();
	let nextCharacter = characters.next();
	let rawCharacterIndex = 0;
	while (!currentCharacter.done) {
		const character = currentCharacter.value;
		const characterLength = fastStringWidth(character);
		if (visible + characterLength <= columns) rows[rows.length - 1] += character;
		else {
			rows.push(character);
			visible = 0;
		}
		if (character === ESC || character === CSI) {
			isInsideEscape = true;
			isInsideLinkEscape = word.startsWith(ANSI_ESCAPE_LINK, rawCharacterIndex + 1);
		}
		if (isInsideEscape) {
			if (isInsideLinkEscape) {
				if (character === ANSI_ESCAPE_BELL) {
					isInsideEscape = false;
					isInsideLinkEscape = false;
				}
			} else if (character === ANSI_SGR_TERMINATOR) isInsideEscape = false;
		} else {
			visible += characterLength;
			if (visible === columns && !nextCharacter.done) {
				rows.push("");
				visible = 0;
			}
		}
		currentCharacter = nextCharacter;
		nextCharacter = characters.next();
		rawCharacterIndex += character.length;
	}
	lastRow = rows.at(-1);
	if (!visible && lastRow !== void 0 && lastRow.length && rows.length > 1) rows[rows.length - 2] += rows.pop();
};
const stringVisibleTrimSpacesRight = (string) => {
	const words = string.split(" ");
	let last = words.length;
	while (last) {
		if (fastStringWidth(words[last - 1])) break;
		last--;
	}
	if (last === words.length) return string;
	return words.slice(0, last).join(" ") + words.slice(last).join("");
};
const exec = (string, columns, options = {}) => {
	if (options.trim !== false && string.trim() === "") return "";
	let returnValue = "";
	let escapeCode;
	let escapeUrl;
	const words = string.split(" ");
	let rows = [""];
	let rowLength = 0;
	for (let index = 0; index < words.length; index++) {
		const word = words[index];
		if (options.trim !== false) {
			const row = rows.at(-1) ?? "";
			const trimmed = row.trimStart();
			if (row.length !== trimmed.length) {
				rows[rows.length - 1] = trimmed;
				rowLength = fastStringWidth(trimmed);
			}
		}
		if (index !== 0) {
			if (rowLength >= columns && (options.wordWrap === false || options.trim === false)) {
				rows.push("");
				rowLength = 0;
			}
			if (rowLength || options.trim === false) {
				rows[rows.length - 1] += " ";
				rowLength++;
			}
		}
		const wordLength = fastStringWidth(word);
		if (options.hard && wordLength > columns) {
			const remainingColumns = columns - rowLength;
			const breaksStartingThisLine = 1 + Math.floor((wordLength - remainingColumns - 1) / columns);
			if (Math.floor((wordLength - 1) / columns) < breaksStartingThisLine) rows.push("");
			wrapWord(rows, word, columns);
			rowLength = fastStringWidth(rows.at(-1) ?? "");
			continue;
		}
		if (rowLength + wordLength > columns && rowLength && wordLength) {
			if (options.wordWrap === false && rowLength < columns) {
				wrapWord(rows, word, columns);
				rowLength = fastStringWidth(rows.at(-1) ?? "");
				continue;
			}
			rows.push("");
			rowLength = 0;
		}
		if (rowLength + wordLength > columns && options.wordWrap === false) {
			wrapWord(rows, word, columns);
			rowLength = fastStringWidth(rows.at(-1) ?? "");
			continue;
		}
		rows[rows.length - 1] += word;
		rowLength += wordLength;
	}
	if (options.trim !== false) rows = rows.map((row) => stringVisibleTrimSpacesRight(row));
	const preString = rows.join("\n");
	let inSurrogate = false;
	for (let i = 0; i < preString.length; i++) {
		const character = preString[i];
		returnValue += character;
		if (!inSurrogate) {
			inSurrogate = character >= "\ud800" && character <= "\udbff";
			if (inSurrogate) continue;
		} else inSurrogate = false;
		if (character === ESC || character === CSI) {
			GROUP_REGEX.lastIndex = i + 1;
			const groups = GROUP_REGEX.exec(preString)?.groups;
			if (groups?.code !== void 0) {
				const code = Number.parseFloat(groups.code);
				escapeCode = code === END_CODE ? void 0 : code;
			} else if (groups?.uri !== void 0) escapeUrl = groups.uri.length === 0 ? void 0 : groups.uri;
		}
		if (preString[i + 1] === "\n") {
			if (escapeUrl) returnValue += wrapAnsiHyperlink("");
			const closingCode = escapeCode ? getClosingCode(escapeCode) : void 0;
			if (escapeCode && closingCode) returnValue += wrapAnsiCode(closingCode);
		} else if (character === "\n") {
			if (escapeCode && getClosingCode(escapeCode)) returnValue += wrapAnsiCode(escapeCode);
			if (escapeUrl) returnValue += wrapAnsiHyperlink(escapeUrl);
		}
	}
	return returnValue;
};
const CRLF_OR_LF = /\r?\n/;
function wrapAnsi(string, columns, options) {
	return String(string).normalize().split(CRLF_OR_LF).map((line) => exec(line, columns, options)).join("\n");
}
//#endregion
//#region ../../../../../../private/tmp/void-prompts-spacing-tools/node_modules/is-unicode-supported/index.js
function isUnicodeSupported() {
	if (process$1.platform !== "win32") return process$1.env.TERM !== "linux";
	return Boolean(process$1.env.CI) || Boolean(process$1.env.WT_SESSION) || Boolean(process$1.env.TERMINUS_SUBLIME) || process$1.env.ConEmuTask === "{cmd::Cmder}" || process$1.env.TERM_PROGRAM === "Terminus-Sublime" || process$1.env.TERM_PROGRAM === "vscode" || process$1.env.TERM === "xterm-256color" || process$1.env.TERM === "alacritty" || process$1.env.TERMINAL_EMULATOR === "JetBrains-JediTerm";
}
//#endregion
//#region src/common.ts
updateSettings$1({ withGuide: false });
/** Wrap using visible columns rather than the length of ANSI escape sequences. */
const wrapTextWithPrefix = (output, text, prefix, startPrefix = prefix) => {
	return wrapAnsi(text, Math.max(1, getColumns(output ?? process.stdout) - Math.max(fastStringWidth$1(prefix), fastStringWidth$1(startPrefix))), {
		hard: true,
		trim: false
	}).split("\n").map((line, index) => `${index === 0 ? startPrefix : prefix}${line}`).join("\n");
};
const getGuide = (opts) => opts?.withGuide ?? settings$1.withGuide;
const promptTitle = (message, state, opts) => {
	if (!message.trim()) return "";
	const hasGuide = getGuide(opts);
	return `${hasGuide ? `${color.gray(S_BAR)}\n` : ""}${wrapTextWithPrefix(opts.output, message, hasGuide ? `${symbolBar(state)} ` : "  ", `${symbol(state)} `)}\n`;
};
const optionText = (output, marker, label, format, suffix = "") => {
	const continuation = " ".repeat(fastStringWidth$1(marker));
	const width = Math.max(1, getColumns(output ?? process.stdout) - 2 - fastStringWidth$1(marker));
	const [first, ...rest] = label.split("\n");
	return wrapAnsi([format(first) + suffix, ...rest.map(format)].join("\n"), width, {
		hard: true,
		trim: false
	}).split("\n").map((line, index) => `${index === 0 ? marker : continuation}${line}`).join("\n");
};
const SELECT_INSTRUCTIONS = ["↑/↓ navigate", "Enter confirm"];
const MULTISELECT_INSTRUCTIONS = [
	"↑/↓ navigate",
	"Space select",
	"Enter confirm"
];
const formatInstructionFooter = (instructions, hasGuide, output) => wrapTextWithPrefix(output, color.dim(instructions.join(" · ")), hasGuide ? `${color.blue(S_BAR)} ` : "  ").split("\n");
const unicode = isUnicodeSupported();
const isCI = () => process.env.CI === "true";
const isTTY = (output) => {
	return output.isTTY === true;
};
const unicodeOr = (c, fallback) => unicode ? c : fallback;
const S_POINTER_ACTIVE = unicodeOr("›", ">");
const S_POINTER_INACTIVE = " ";
const S_STEP_ACTIVE = S_POINTER_ACTIVE;
const S_STEP_CANCEL = unicodeOr("■", "x");
const S_STEP_ERROR = unicodeOr("▲", "x");
const S_STEP_SUBMIT = unicodeOr("◇", "o");
const S_BAR_START = unicodeOr("┌", "T");
const S_BAR = unicodeOr("│", "|");
const S_BAR_END = unicodeOr("└", "—");
const S_BAR_START_RIGHT = unicodeOr("┐", "T");
const S_BAR_END_RIGHT = unicodeOr("┘", "—");
const S_RADIO_ACTIVE = S_POINTER_ACTIVE;
const S_RADIO_INACTIVE = " ";
const S_CHECKBOX_ACTIVE = unicodeOr("◻", "[•]");
const S_CHECKBOX_SELECTED = unicodeOr("◼", "[+]");
const S_CHECKBOX_INACTIVE = unicodeOr("◻", "[ ]");
const S_PASSWORD_MASK = unicodeOr("▪", "•");
const S_BAR_H = unicodeOr("─", "-");
const S_CORNER_TOP_RIGHT = unicodeOr("╮", "+");
const S_CONNECT_LEFT = unicodeOr("├", "+");
const S_CORNER_BOTTOM_RIGHT = unicodeOr("╯", "+");
const S_CORNER_BOTTOM_LEFT = unicodeOr("╰", "+");
const S_CORNER_TOP_LEFT = unicodeOr("╭", "+");
const S_INFO = unicodeOr("●", "•");
const S_SUCCESS = unicodeOr("◆", "*");
const S_WARN = unicodeOr("▲", "!");
const S_ERROR = unicodeOr("■", "x");
const completeColor = (value) => color.gray(value);
const symbol = (state) => {
	switch (state) {
		case "initial":
		case "active": return color.blue(S_STEP_ACTIVE);
		case "cancel": return color.red(S_STEP_CANCEL);
		case "error": return color.yellow(S_STEP_ERROR);
		case "validating": return color.dim(S_STEP_ACTIVE);
		case "submit": return completeColor(S_STEP_SUBMIT);
		default: return color.blue(S_STEP_ACTIVE);
	}
};
const symbolBar = (state) => {
	switch (state) {
		case "initial":
		case "active": return color.blue(S_BAR);
		case "cancel": return color.red(S_BAR);
		case "error": return color.yellow(S_BAR);
		case "validating": return color.dim(S_BAR);
		case "submit": return completeColor(S_BAR);
		default: return color.blue(S_BAR);
	}
};
//#endregion
//#region src/limit-options.ts
const trimLines = (groups, initialLineCount, startIndex, endIndex, maxLines, fromEnd = false) => {
	let lineCount = initialLineCount;
	let removals = 0;
	if (fromEnd) for (let i = endIndex - 1; i >= startIndex; i--) {
		const group = groups[i];
		if (group) lineCount -= group.length;
		removals++;
		if (lineCount <= maxLines) break;
	}
	else for (let i = startIndex; i < endIndex; i++) {
		const group = groups[i];
		if (group) lineCount -= group.length;
		removals++;
		if (lineCount <= maxLines) break;
	}
	return {
		lineCount,
		removals
	};
};
/**
* Trims an option list to what fits the terminal, while keeping the active
* option (cursor) visible using a Clack style sliding window.
*
* @returns The lines to render.
*
* @see https://bomb.sh/docs/clack/packages/prompts/#limitoptions
*
* @example
* ```ts
* import { limitOptions } from '@voidzero-dev/vite-plus-prompts';
* import color from 'picocolors';
*
* const options = ['apple', 'banana', 'cherry', 'date'];
* const lines = limitOptions({
*   options,
*   cursor: 2,
*   maxItems: 8,
*   style: (opt, active) =>
*     active ? color.blue(opt) : color.dim(opt),
* });
* ```
*/
const limitOptions = ({ cursor, options, style, output = process.stdout, maxItems = Number.POSITIVE_INFINITY, columnPadding = 0, rowPadding = 4 }) => {
	const columns = getColumns(output);
	const maxWidth = Math.max(1, columns - columnPadding);
	const rows = getRows(output);
	const overflowFormat = color.dim("...");
	const outputMaxItems = Math.max(rows - rowPadding, 0);
	const computedMaxItems = Math.max(Math.min(maxItems, outputMaxItems), 5);
	let slidingWindowLocation = 0;
	if (cursor >= computedMaxItems - 3) slidingWindowLocation = Math.max(Math.min(cursor - computedMaxItems + 3, options.length - computedMaxItems), 0);
	let shouldRenderTopEllipsis = computedMaxItems < options.length && slidingWindowLocation > 0;
	let shouldRenderBottomEllipsis = computedMaxItems < options.length && slidingWindowLocation + computedMaxItems < options.length;
	const slidingWindowLocationEnd = Math.min(slidingWindowLocation + computedMaxItems, options.length);
	const lineGroups = [];
	let lineCount = 0;
	if (shouldRenderTopEllipsis) lineCount++;
	if (shouldRenderBottomEllipsis) lineCount++;
	const slidingWindowLocationWithEllipsis = slidingWindowLocation + (shouldRenderTopEllipsis ? 1 : 0);
	const slidingWindowLocationEndWithEllipsis = slidingWindowLocationEnd - (shouldRenderBottomEllipsis ? 1 : 0);
	for (let i = slidingWindowLocationWithEllipsis; i < slidingWindowLocationEndWithEllipsis; i++) {
		const option = options[i];
		const wrappedLines = wrapAnsi(option === void 0 ? "" : style(option, i === cursor), maxWidth, {
			hard: true,
			trim: false
		}).split("\n");
		lineGroups.push(wrappedLines);
		lineCount += wrappedLines.length;
	}
	if (lineCount > outputMaxItems) {
		let precedingRemovals = 0;
		let followingRemovals = 0;
		let newLineCount = lineCount;
		const cursorGroupIndex = cursor - slidingWindowLocationWithEllipsis;
		let adjustedMax = outputMaxItems;
		const trimPreceding = () => trimLines(lineGroups, newLineCount, 0, cursorGroupIndex, adjustedMax);
		const trimFollowing = () => trimLines(lineGroups, newLineCount, cursorGroupIndex + 1, lineGroups.length, adjustedMax, true);
		if (shouldRenderTopEllipsis) {
			({lineCount: newLineCount, removals: precedingRemovals} = trimPreceding());
			if (newLineCount > adjustedMax) {
				if (!shouldRenderBottomEllipsis) adjustedMax -= 1;
				({lineCount: newLineCount, removals: followingRemovals} = trimFollowing());
			}
		} else {
			if (!shouldRenderBottomEllipsis) adjustedMax -= 1;
			({lineCount: newLineCount, removals: followingRemovals} = trimFollowing());
			if (newLineCount > adjustedMax) {
				adjustedMax -= 1;
				({lineCount: newLineCount, removals: precedingRemovals} = trimPreceding());
			}
		}
		if (precedingRemovals > 0) {
			shouldRenderTopEllipsis = true;
			lineGroups.splice(0, precedingRemovals);
		}
		if (followingRemovals > 0) {
			shouldRenderBottomEllipsis = true;
			lineGroups.splice(lineGroups.length - followingRemovals, followingRemovals);
		}
	}
	const result = [];
	if (shouldRenderTopEllipsis) result.push(overflowFormat);
	for (const lineGroup of lineGroups) for (const line of lineGroup) result.push(line);
	if (shouldRenderBottomEllipsis) result.push(overflowFormat);
	return result;
};
//#endregion
//#region src/autocomplete.ts
function getLabel(option) {
	return option.label ?? String(option.value ?? "");
}
function getFilteredOption(searchText, option) {
	if (!searchText) return true;
	const label = (option.label ?? String(option.value ?? "")).toLowerCase();
	const hint = (option.hint ?? "").toLowerCase();
	const value = String(option.value).toLowerCase();
	const term = searchText.toLowerCase();
	return label.includes(term) || hint.includes(term) || value.includes(term);
}
function getSelectedOptions(values, options) {
	const results = [];
	for (const option of options) if (values.includes(option.value)) results.push(option);
	return results;
}
const withMarker = (output, marker, label, format, suffix = "") => optionText(output, `${marker} `, label, format, suffix);
const withMarkerAndIndicator = (output, marker, indicator, _width, label, format, suffix = "") => optionText(output, `${marker} ${indicator} `, label, format, suffix);
const autocomplete = (opts) => {
	return new AutocompletePrompt({
		options: opts.options,
		initialValue: opts.initialValue !== void 0 ? [opts.initialValue] : void 0,
		initialUserInput: opts.initialUserInput,
		placeholder: opts.placeholder,
		completeOnTab: opts.completeOnTab,
		filter: opts.filter ?? ((search, opt) => {
			return getFilteredOption(search, opt);
		}),
		signal: opts.signal,
		input: opts.input,
		accessible: opts.accessible,
		output: opts.output,
		validate: opts.validate,
		render() {
			const hasGuide = getGuide(opts);
			const nestedPrefix = "  ";
			const headings = promptTitle(opts.message, this.state, opts).trimEnd().split("\n");
			const userInput = this.userInput;
			const options = this.options;
			const placeholder = opts.placeholder;
			const showPlaceholder = userInput === "" && placeholder !== void 0;
			switch (this.state) {
				case "submit": {
					const selected = getSelectedOptions(this.selectedValues, options);
					const label = selected.length > 0 ? color.dim(selected.map(getLabel).join(", ")) : "";
					const submitPrefix = hasGuide ? `${color.gray(S_BAR)} ` : nestedPrefix;
					return `${headings.join("\n")}\n${submitPrefix}${label}\n`;
				}
				case "cancel": {
					const userInputText = userInput ? color.strikethrough(color.dim(userInput)) : "";
					const cancelPrefix = hasGuide ? `${color.gray(S_BAR)} ` : nestedPrefix;
					return `${headings.join("\n")}\n${cancelPrefix}${userInputText}\n`;
				}
				default: {
					const barColor = this.state === "error" ? color.yellow : color.blue;
					const guidePrefix = hasGuide ? `${barColor(S_BAR)} ` : nestedPrefix;
					const guidePrefixEnd = hasGuide ? barColor(S_BAR_END) : "";
					let searchText = "";
					if (this.isNavigating || showPlaceholder) {
						const searchTextValue = showPlaceholder ? placeholder : userInput;
						searchText = searchTextValue !== "" ? ` ${color.dim(searchTextValue)}` : "";
					} else searchText = ` ${this.userInputWithCursor}`;
					const matches = this.filteredOptions.length !== options.length ? color.dim(` (${this.filteredOptions.length} match${this.filteredOptions.length === 1 ? "" : "es"})`) : "";
					const noResults = this.filteredOptions.length === 0 && userInput ? [`${guidePrefix}${color.yellow("No matches found")}`] : [];
					const validationError = this.state === "error" ? [wrapTextWithPrefix(opts.output, color.yellow(this.error), guidePrefix)] : [];
					if (hasGuide) headings.push(guidePrefix.trimEnd());
					headings.push(wrapTextWithPrefix(opts.output, `${color.dim("Search:")}${searchText}${matches}`, guidePrefix), ...noResults, ...validationError);
					const instructions = [
						`${color.dim("↑/↓")} navigate`,
						...opts.completeOnTab ? [`${color.dim("Tab")} complete`] : [],
						`${color.dim("Enter")} confirm`,
						`${color.dim("Type")} to search`
					];
					const footers = wrapTextWithPrefix(opts.output, color.dim(instructions.join(" · ")), guidePrefix).split("\n");
					if (hasGuide) footers.push(guidePrefixEnd);
					const displayOptions = this.filteredOptions.length === 0 ? [] : limitOptions({
						cursor: this.cursor,
						options: this.filteredOptions,
						columnPadding: hasGuide ? 2 : 2,
						rowPadding: headings.flatMap((line) => line.split("\n")).length + footers.length,
						style: (option, active) => {
							const label = getLabel(option);
							const hint = option.hint && option.value === this.focusedValue ? color.gray(` (${option.hint})`) : "";
							if (option.disabled) return withMarker(opts.output, color.gray(" "), label, (text) => color.strikethrough(color.gray(text)));
							return active ? withMarker(opts.output, color.blue(S_POINTER_ACTIVE), label, (text) => color.blue(color.bold(text)), hint) : withMarker(opts.output, color.dim(" "), label, color.dim, hint);
						},
						maxItems: opts.maxItems,
						output: opts.output
					});
					return [
						...headings,
						...displayOptions.map((option) => `${guidePrefix}${option}`),
						...footers
					].join("\n");
				}
			}
		}
	}).prompt();
};
/**
* Integrated autocomplete multiselect - combines type-ahead filtering with multiselect in one UI
*/
const autocompleteMultiselect = (opts) => {
	const formatOption = (option, active, selectedValues, focusedValue) => {
		if (option.disabled) return optionText(opts.output, `${color.gray(" ")} ${color.gray(S_CHECKBOX_INACTIVE)} `, option.label ?? String(option.value ?? ""), (text) => color.strikethrough(color.gray(text)));
		const isSelected = selectedValues.includes(option.value);
		const label = option.label ?? String(option.value ?? "");
		const hint = option.hint && focusedValue !== void 0 && option.value === focusedValue ? color.gray(` (${option.hint})`) : "";
		const checkboxRaw = isSelected ? S_CHECKBOX_SELECTED : S_CHECKBOX_INACTIVE;
		const checkbox = isSelected ? color.blue(checkboxRaw) : color.dim(checkboxRaw);
		const marker = active ? color.blue(S_POINTER_ACTIVE) : color.dim(" ");
		return withMarkerAndIndicator(opts.output, marker, checkbox, checkboxRaw.length, label, active ? (text) => color.blue(color.bold(text)) : color.dim, hint);
	};
	return new AutocompletePrompt({
		options: opts.options,
		multiple: true,
		placeholder: opts.placeholder,
		filter: opts.filter ?? ((search, opt) => {
			return getFilteredOption(search, opt);
		}),
		validate: (value) => {
			if (opts.required && (!Array.isArray(value) || value.length === 0)) return "Please select at least one item";
			return opts.validate ? runValidation(opts.validate, value) : void 0;
		},
		initialValue: opts.initialValues,
		signal: opts.signal,
		input: opts.input,
		accessible: opts.accessible,
		output: opts.output,
		render() {
			const hasGuide = getGuide(opts);
			const nestedPrefix = "  ";
			const title = promptTitle(opts.message, this.state, opts);
			const userInput = this.userInput;
			const placeholder = opts.placeholder;
			const showPlaceholder = userInput === "" && placeholder !== void 0;
			const searchText = this.isNavigating || showPlaceholder ? color.dim(showPlaceholder ? placeholder : userInput) : this.userInputWithCursor;
			const options = this.options;
			const matches = this.filteredOptions.length !== options.length ? color.dim(` (${this.filteredOptions.length} match${this.filteredOptions.length === 1 ? "" : "es"})`) : "";
			switch (this.state) {
				case "submit": {
					const submitPrefix = hasGuide ? `${color.gray(S_BAR)} ` : "";
					return `${title}${hasGuide ? submitPrefix : nestedPrefix}${color.dim(`${this.selectedValues.length} items selected`)}\n`;
				}
				case "cancel": {
					const cancelPrefix = hasGuide ? `${color.gray(S_BAR)} ` : "";
					return `${title}${hasGuide ? cancelPrefix : nestedPrefix}${color.strikethrough(color.dim(userInput))}\n`;
				}
				default: {
					const barColor = this.state === "error" ? color.yellow : color.blue;
					const prefix = hasGuide ? `${barColor(S_BAR)} ` : nestedPrefix;
					const footerEnd = hasGuide ? [barColor(S_BAR_END)] : [];
					const instructions = [
						`${color.dim("↑/↓")} navigate`,
						`${color.dim(this.isNavigating ? "Space/Tab" : "Tab")} select`,
						`${color.dim("Enter")} confirm`,
						`${color.dim("Type")} to search`
					];
					const noResults = this.filteredOptions.length === 0 && userInput ? [`${prefix}${color.yellow("No matches found")}`] : [];
					const errorMessage = this.state === "error" ? [wrapTextWithPrefix(opts.output, color.yellow(this.error), prefix)] : [];
					const headerLines = [
						...title.trimEnd().split("\n"),
						wrapTextWithPrefix(opts.output, `${color.dim("Search:")} ${searchText}${matches}`, prefix),
						...noResults,
						...errorMessage
					];
					const footerLines = [...wrapTextWithPrefix(opts.output, color.dim(instructions.join(" · ")), prefix).split("\n"), ...footerEnd];
					const displayOptions = limitOptions({
						cursor: this.cursor,
						options: this.filteredOptions,
						style: (option, active) => formatOption(option, active, this.selectedValues, this.focusedValue),
						maxItems: opts.maxItems,
						output: opts.output,
						columnPadding: 2,
						rowPadding: headerLines.flatMap((line) => line.split("\n")).length + footerLines.length
					});
					return [
						...headerLines,
						...displayOptions.map((option) => `${prefix}${option}`),
						...footerLines
					].join("\n");
				}
			}
		}
	}).prompt();
};
//#endregion
//#region src/box.ts
const roundedSymbols = [
	S_CORNER_TOP_LEFT,
	S_CORNER_TOP_RIGHT,
	S_CORNER_BOTTOM_LEFT,
	S_CORNER_BOTTOM_RIGHT
];
const squareSymbols = [
	S_BAR_START,
	S_BAR_START_RIGHT,
	S_BAR_END,
	S_BAR_END_RIGHT
];
function getPaddingForLine(lineLength, innerWidth, padding, contentAlign) {
	let leftPadding = padding;
	let rightPadding = padding;
	if (contentAlign === "center") leftPadding = Math.floor((innerWidth - lineLength) / 2);
	else if (contentAlign === "right") leftPadding = innerWidth - lineLength - padding;
	rightPadding = innerWidth - leftPadding - lineLength;
	return [leftPadding, rightPadding];
}
const defaultFormatBorder = color.gray;
const box = (message = "", title = "", opts) => {
	const output = opts?.output ?? process.stdout;
	const columns = getColumns(output);
	const borderTotalWidth = 2;
	let titlePadding = Math.max(0, opts?.titlePadding ?? 1);
	let contentPadding = Math.max(0, opts?.contentPadding ?? 2);
	const width = opts?.width === void 0 || opts.width === "auto" ? 1 : Math.max(0, Math.min(1, opts.width));
	const linePrefix = !getGuide(opts) ? "" : `${color.gray(S_BAR)} `;
	const formatBorder = opts?.formatBorder ?? defaultFormatBorder;
	const symbols = (opts?.rounded !== false ? roundedSymbols : squareSymbols).map(formatBorder);
	const hSymbol = formatBorder(S_BAR_H);
	const vSymbol = formatBorder(S_BAR);
	const linePrefixWidth = fastStringWidth$1(linePrefix);
	const titleWidth = fastStringWidth$1(title);
	const maxBoxWidth = columns - linePrefixWidth;
	let boxWidth = Math.max(Math.min(8, maxBoxWidth), Math.floor(columns * width) - linePrefixWidth);
	if (opts?.width === "auto") {
		const lines = message.split("\n");
		let longestLine = titleWidth + titlePadding * 2;
		for (const line of lines) {
			const lineWithPadding = fastStringWidth$1(line) + contentPadding * 2;
			if (lineWithPadding > longestLine) longestLine = lineWithPadding;
		}
		const longestLineWidth = longestLine + borderTotalWidth;
		if (longestLineWidth < boxWidth) boxWidth = longestLineWidth;
	}
	if (boxWidth % 2 !== 0) {
		if (boxWidth < maxBoxWidth) boxWidth++;
		else boxWidth--;
	}
	const innerWidth = Math.max(0, boxWidth - borderTotalWidth);
	titlePadding = Math.min(titlePadding, Math.floor(innerWidth / 2));
	contentPadding = Math.min(contentPadding, Math.max(0, Math.floor((innerWidth - 1) / 2)));
	const maxTitleLength = innerWidth - titlePadding * 2;
	let truncatedTitle = title;
	if (titleWidth > maxTitleLength) {
		truncatedTitle = "";
		const suffix = maxTitleLength > 0 ? "…" : "";
		for (const { segment } of new Intl.Segmenter().segment(stripVTControlCharacters(title))) {
			if (fastStringWidth$1(truncatedTitle + segment + suffix) > maxTitleLength) break;
			truncatedTitle += segment;
		}
		truncatedTitle += suffix;
	}
	const [titlePaddingLeft, titlePaddingRight] = getPaddingForLine(fastStringWidth$1(truncatedTitle), innerWidth, titlePadding, opts?.titleAlign);
	const wrappedMessage = wrapAnsi(message, Math.max(1, innerWidth - contentPadding * 2), {
		hard: true,
		trim: false
	});
	output.write(`${linePrefix}${symbols[0]}${hSymbol.repeat(titlePaddingLeft)}${truncatedTitle}${hSymbol.repeat(titlePaddingRight)}${symbols[1]}\n`);
	const wrappedLines = wrappedMessage.split("\n");
	for (const line of wrappedLines) {
		const [leftLinePadding, rightLinePadding] = getPaddingForLine(fastStringWidth$1(line), innerWidth, contentPadding, opts?.contentAlign);
		output.write(`${linePrefix}${vSymbol}${" ".repeat(leftLinePadding)}${line}${" ".repeat(rightLinePadding)}${vSymbol}\n`);
	}
	output.write(`${linePrefix}${symbols[2]}${hSymbol.repeat(innerWidth)}${symbols[3]}\n`);
};
//#endregion
//#region src/milestone.ts
/**
* Render-milestone markers for the PTY snapshot suite
* (crates/vp_cli_snapshots): invisible window-title updates the runner
* synchronizes on via `expect-milestone` interactions. Emission is gated on
* `VP_EMIT_MILESTONES=1`, which only the runner sets; real terminals and
* piped output never see these markers as content (they only update the
* window title, which the runner's PTY captures).
*
* Protocol (shared with vite-task's `pty_terminal_test_client` crate):
* `OSC 2 ; pty-terminal-test:<32-hex-id>:<base64url(name)> ST`. The runner
* decodes the title with `decode_milestone_title`, ignoring ordinary title
* updates. A fresh random id per emission keeps repeated milestones with the
* same name observable as distinct title changes through Windows ConPTY.
*/
const MILESTONE_TITLE_MARKER = "pty-terminal-test:";
const OSC2_OPEN = "\x1B]2;";
const ST = "\x1B\\";
const MILESTONES_ENABLED = process.env.VP_EMIT_MILESTONES === "1";
/**
* Returns the encoded milestone byte sequence for `name`, or an empty string
* when emission is disabled. Append the result to a rendered prompt frame so
* the marker arrives in the output stream together with the render it marks.
*/
function milestone(name) {
	if (!MILESTONES_ENABLED) return "";
	const id = randomBytes(16).toString("hex");
	const encodedName = Buffer.from(name, "utf8").toString("base64url");
	return `${OSC2_OPEN}${MILESTONE_TITLE_MARKER}${id}:${encodedName}${ST}`;
}
/**
* Milestone for a prompt render, following the runner naming convention
* `<kind>:<id>:<state>` (e.g. `select:template:1`, `confirm:approve:yes`,
* `text:project-name:my-app`). `id` defaults to the prompt kind; pass
* `testId` at ambiguous call sites (multiple prompts of one kind in a flow).
*/
function promptMilestone(kind, id, state) {
	return milestone(`${kind}:${id ?? kind}:${state}`);
}
//#endregion
//#region src/confirm.ts
const confirm = (opts) => {
	const active = opts.active ?? "Yes";
	const inactive = opts.inactive ?? "No";
	return new ConfirmPrompt({
		active,
		inactive,
		signal: opts.signal,
		input: opts.input,
		accessible: opts.accessible,
		output: opts.output,
		initialValue: opts.initialValue ?? true,
		render() {
			const hasGuide = getGuide(opts);
			const nestedPrefix = "  ";
			const title = promptTitle(opts.message, this.state, opts);
			const value = this.value ? active : inactive;
			switch (this.state) {
				case "submit": return `${title}${hasGuide ? `${color.gray(S_BAR)} ` : nestedPrefix}${color.dim(value)}\n${promptMilestone("confirm", opts.testId, "submit")}`;
				case "cancel": return `${title}${hasGuide ? `${color.gray(S_BAR)} ` : nestedPrefix}${color.strikethrough(color.dim(value))}${hasGuide ? `\n${color.gray(S_BAR)}` : ""}\n${promptMilestone("confirm", opts.testId, "cancel")}`;
				default: {
					const defaultPrefix = hasGuide ? `${color.blue(S_BAR)} ` : nestedPrefix;
					const defaultPrefixEnd = hasGuide ? color.blue(S_BAR_END) : "";
					return `${title}${defaultPrefix}${this.value ? `${color.blue(S_POINTER_ACTIVE)} ${color.bold(active)}` : `${color.dim(" ")} ${color.dim(active)}`}${opts.vertical ? hasGuide ? `\n${color.blue(S_BAR)} ` : `\n${nestedPrefix}` : ` ${color.dim("/")} `}${!this.value ? `${color.blue(S_POINTER_ACTIVE)} ${color.bold(inactive)}` : `${color.dim(" ")} ${color.dim(inactive)}`}${hasGuide ? `\n${defaultPrefixEnd}` : ""}\n${promptMilestone("confirm", opts.testId, this.value ? "yes" : "no")}`;
				}
			}
		}
	}).prompt();
};
//#endregion
//#region src/group.ts
/**
* Define a group of prompts to be displayed
* and return a results of objects within the group
*/
const group = async (prompts, opts) => {
	const results = {};
	const promptNames = Object.keys(prompts);
	for (const name of promptNames) {
		const prompt = prompts[name];
		const result = await prompt({ results })?.catch((e) => {
			throw e;
		});
		if (typeof opts?.onCancel === "function" && isCancel$1(result)) {
			results[name] = "canceled";
			opts.onCancel({ results });
			continue;
		}
		results[name] = result;
	}
	return results;
};
//#endregion
//#region src/group-multi-select.ts
const groupMultiselect = (opts) => {
	const { selectableGroups = true, groupSpacing = 0 } = opts;
	const hasGuide = getGuide(opts);
	const nestedPrefix = "  ";
	const withMarkerAndPrefix = (marker, prefix, _prefixWidth, label, format, firstLineSuffix = "", spacingPrefix = "") => {
		return spacingPrefix + optionText(opts.output, `${marker} ${prefix}`, label, format, firstLineSuffix);
	};
	const opt = (option, state, options = []) => {
		const label = option.label ?? String(option.value);
		const hint = option.hint && (state === "active" || state === "active-selected") ? ` ${color.gray(`(${option.hint})`)}` : "";
		const isItem = typeof option.group === "string";
		const next = isItem && (options[options.indexOf(option) + 1] ?? { group: true });
		const isLast = isItem && next && next.group === true;
		const branchPrefixRaw = isItem ? selectableGroups ? `${isLast ? S_BAR_END : S_BAR} ` : "  " : "";
		let spacingPrefix = "";
		if (groupSpacing > 0 && !isItem && options.indexOf(option) > 0) spacingPrefix = "\n".repeat(groupSpacing);
		if (state === "cancelled") return color.strikethrough(color.dim(label));
		if (state === "submitted") return color.dim(label);
		const marker = state === "active" || state === "active-selected" ? color.blue(S_POINTER_ACTIVE) : color.dim(" ");
		const branchPrefix = color.dim(branchPrefixRaw);
		const hasCheckbox = isItem || selectableGroups;
		const checkboxRaw = hasCheckbox ? state === "active" || state === "group-active" ? S_CHECKBOX_ACTIVE : state === "selected" || state === "active-selected" || state === "group-active-selected" ? S_CHECKBOX_SELECTED : S_CHECKBOX_INACTIVE : "";
		const checkbox = hasCheckbox ? checkboxRaw === S_CHECKBOX_SELECTED ? color.blue(checkboxRaw) : checkboxRaw === S_CHECKBOX_ACTIVE ? color.blue(checkboxRaw) : color.dim(checkboxRaw) : "";
		const format = state === "active" || state === "active-selected" ? (text) => color.blue(color.bold(text)) : color.dim;
		const styledPrefix = `${branchPrefix}${hasCheckbox ? `${checkbox} ` : ""}`;
		const prefixWidth = branchPrefixRaw.length + (hasCheckbox ? checkboxRaw.length + 1 : 0);
		return withMarkerAndPrefix(marker, styledPrefix, prefixWidth, label, format, hint, spacingPrefix);
	};
	const required = opts.required ?? true;
	return new GroupMultiSelectPrompt({
		options: opts.options,
		signal: opts.signal,
		input: opts.input,
		accessible: opts.accessible,
		output: opts.output,
		initialValues: opts.initialValues,
		required,
		cursorAt: opts.cursorAt,
		selectableGroups,
		validate(selected) {
			if (required && (selected === void 0 || selected.length === 0)) return "Please select at least one option.";
		},
		render() {
			const title = promptTitle(opts.message, this.state, opts);
			const value = this.value ?? [];
			switch (this.state) {
				case "submit": {
					const selectedOptions = this.options.filter(({ value: optionValue }) => value.includes(optionValue)).map((option) => opt(option, "submitted"));
					return `${title}${hasGuide ? `${color.gray(S_BAR)} ` : nestedPrefix}${selectedOptions.length === 0 ? "" : selectedOptions.join(color.dim(", "))}\n`;
				}
				case "cancel": {
					const label = this.options.filter(({ value: optionValue }) => value.includes(optionValue)).map((option) => opt(option, "cancelled")).join(color.dim(", "));
					if (!label.trim()) return hasGuide ? `${title}${color.gray(S_BAR)}\n` : `${title.trimEnd()}\n`;
					const cancelPrefix = hasGuide ? `${color.gray(S_BAR)} ` : nestedPrefix;
					return hasGuide ? `${title}${cancelPrefix}${label}\n${color.gray(S_BAR)}\n` : `${title}${cancelPrefix}${label}\n`;
				}
				default: {
					const prefix = hasGuide ? `${this.state === "error" ? color.yellow(S_BAR) : color.blue(S_BAR)} ` : nestedPrefix;
					const footer = opts.showInstructions === false ? [] : formatInstructionFooter(MULTISELECT_INSTRUCTIONS, hasGuide, opts.output);
					if (this.state === "error") footer.push(wrapTextWithPrefix(opts.output, color.yellow(this.error), hasGuide ? `${color.yellow(S_BAR_END)} ` : nestedPrefix));
					else if (hasGuide) footer.push(color.blue(S_BAR_END));
					return `${title}${limitOptions({
						output: opts.output,
						options: this.options,
						cursor: this.cursor,
						maxItems: opts.maxItems,
						columnPadding: 2,
						rowPadding: title.split("\n").length + footer.length + 1,
						style: (option, active) => {
							const selected = value.includes(option.value) || option.group === true && this.isGroupSelected(String(option.value));
							const groupActive = !active && typeof option.group === "string" && this.options[this.cursor]?.value === option.group;
							return opt(option, groupActive ? selected ? "group-active-selected" : "group-active" : active ? selected ? "active-selected" : "active" : selected ? "selected" : "inactive", this.options);
						}
					}).map((line) => `${line ? prefix : hasGuide ? prefix.trimEnd() : ""}${line}`).join("\n")}\n${footer.join("\n")}\n`;
				}
			}
		}
	}).prompt();
};
//#endregion
//#region src/log.ts
const log = {
	message: (message = [], { symbol, secondarySymbol = color.gray(S_BAR), output = process.stdout, spacing = 0, withGuide } = {}) => {
		const parts = [];
		const hasGuide = getGuide({ withGuide });
		const spacingString = !hasGuide ? "" : secondarySymbol;
		const prefix = symbol ? `${symbol} ` : hasGuide ? `${secondarySymbol} ` : "";
		const marker = symbol ?? secondarySymbol;
		const secondaryPrefix = hasGuide ? `${secondarySymbol} ` : symbol ? "  " : "";
		for (let i = 0; i < spacing; i++) parts.push(spacingString);
		const messageParts = Array.isArray(message) ? message : message.split("\n");
		if (messageParts.length > 0) {
			const [firstLine, ...lines] = messageParts;
			if (firstLine.length > 0) parts.push(wrapTextWithPrefix(output, firstLine, secondaryPrefix, prefix));
			else parts.push(hasGuide || symbol ? marker : "");
			for (const ln of lines) if (ln.length > 0) parts.push(wrapTextWithPrefix(output, ln, secondaryPrefix));
			else parts.push(hasGuide ? secondarySymbol : "");
		}
		output.write(`${parts.join("\n")}\n`);
	},
	info: (message, opts) => {
		log.message(message, {
			...opts,
			symbol: color.blue(S_INFO)
		});
	},
	success: (message, opts) => {
		log.message(message, {
			...opts,
			symbol: completeColor(S_SUCCESS)
		});
	},
	step: (message, opts) => {
		log.message(message, {
			...opts,
			symbol: completeColor(S_STEP_SUBMIT)
		});
	},
	warn: (message, opts) => {
		log.message(message, {
			...opts,
			symbol: color.yellow(S_WARN)
		});
	},
	/** alias for `log.warn()`. */
	warning: (message, opts) => {
		log.warn(message, opts);
	},
	error: (message, opts) => {
		log.message(message, {
			...opts,
			symbol: color.red(S_ERROR)
		});
	}
};
//#endregion
//#region src/messages.ts
const cancel = (message = "", opts) => {
	const output = opts?.output ?? process.stdout;
	const prefix = getGuide(opts) ? `${color.gray(S_BAR_END)} ` : "";
	output.write(`${prefix}${color.red(message)}\n\n`);
};
const intro = (title = "", opts) => {
	const output = opts?.output ?? process.stdout;
	const prefix = getGuide(opts) ? `${color.gray(S_BAR_START)} ` : "";
	output.write(`${prefix}${title}\n\n`);
};
const outro = (message = "", opts) => {
	const output = opts?.output ?? process.stdout;
	const prefix = getGuide(opts) ? `${color.gray(S_BAR)}\n${color.gray(S_BAR_END)} ` : "";
	output.write(`${prefix}${message}\n\n`);
};
//#endregion
//#region src/multi-select.ts
const computeLabel$1 = (label, format) => {
	return label.split("\n").map((line) => format(line)).join("\n");
};
const multiselect = (opts) => {
	const withMarkerAndCheckbox = (marker, checkbox, _width, label, format, suffix = "") => optionText(opts.output, `${marker} ${checkbox} `, label, format, suffix);
	const opt = (option, state) => {
		const label = option.label ?? String(option.value);
		const hint = option.hint ? ` ${color.gray(`(${option.hint})`)}` : "";
		if (state === "disabled") return withMarkerAndCheckbox(color.gray(" "), color.gray(S_CHECKBOX_INACTIVE), S_CHECKBOX_INACTIVE.length, label, (str) => color.strikethrough(color.gray(str)), option.hint ? ` ${color.dim(`(${option.hint ?? "disabled"})`)}` : "");
		if (state === "active") return withMarkerAndCheckbox(color.blue(S_POINTER_ACTIVE), color.blue(S_CHECKBOX_ACTIVE), S_CHECKBOX_ACTIVE.length, label, (text) => color.blue(color.bold(text)), hint);
		if (state === "selected") return withMarkerAndCheckbox(color.dim(" "), color.blue(S_CHECKBOX_SELECTED), S_CHECKBOX_SELECTED.length, label, color.dim);
		if (state === "cancelled") return computeLabel$1(label, (text) => color.strikethrough(color.dim(text)));
		if (state === "active-selected") return withMarkerAndCheckbox(color.blue(S_POINTER_ACTIVE), color.blue(S_CHECKBOX_SELECTED), S_CHECKBOX_SELECTED.length, label, (text) => color.blue(color.bold(text)), hint);
		if (state === "submitted") return computeLabel$1(label, color.dim);
		return withMarkerAndCheckbox(color.dim(" "), color.dim(S_CHECKBOX_INACTIVE), S_CHECKBOX_INACTIVE.length, label, color.dim);
	};
	const required = opts.required ?? true;
	return new MultiSelectPrompt({
		options: opts.options,
		signal: opts.signal,
		input: opts.input,
		accessible: opts.accessible,
		output: opts.output,
		initialValues: opts.initialValues,
		required,
		cursorAt: opts.cursorAt,
		validate(selected) {
			if (required && (selected === void 0 || selected.length === 0)) return "Please select at least one option.";
		},
		render() {
			const hasGuide = getGuide(opts);
			const nestedPrefix = "  ";
			const title = promptTitle(opts.message, this.state, opts);
			const value = this.value ?? [];
			const instructions = opts.showInstructions === false ? [] : formatInstructionFooter(MULTISELECT_INSTRUCTIONS, hasGuide, opts.output);
			const hint = instructions.join("\n");
			const styleOption = (option, active) => {
				if (option.disabled) return opt(option, "disabled");
				const selected = value.includes(option.value);
				if (active && selected) return opt(option, "active-selected");
				if (selected) return opt(option, "selected");
				return opt(option, active ? "active" : "inactive");
			};
			switch (this.state) {
				case "submit": {
					const submitText = this.options.filter(({ value: optionValue }) => value.includes(optionValue)).map((option) => opt(option, "submitted")).join(color.dim(", ")) || color.dim("none");
					const submitPrefix = hasGuide ? `${color.gray(S_BAR)} ` : nestedPrefix;
					return `${title}${wrapTextWithPrefix(opts.output, submitText, submitPrefix)}\n`;
				}
				case "cancel": {
					const label = this.options.filter(({ value: optionValue }) => value.includes(optionValue)).map((option) => opt(option, "cancelled")).join(color.dim(", "));
					if (label.trim() === "") return hasGuide ? `${title}${color.gray(S_BAR)}\n` : `${title.trimEnd()}\n`;
					const cancelPrefix = hasGuide ? `${color.gray(S_BAR)} ` : nestedPrefix;
					const wrappedLabel = wrapTextWithPrefix(opts.output, label, cancelPrefix);
					return hasGuide ? `${title}${wrappedLabel}\n${color.gray(S_BAR)}\n` : `${title}${wrappedLabel}\n`;
				}
				case "error": {
					const prefix = hasGuide ? `${color.yellow(S_BAR)} ` : nestedPrefix;
					const footer = wrapTextWithPrefix(opts.output, color.yellow(this.error), hasGuide ? `${color.yellow(S_BAR_END)} ` : nestedPrefix);
					const titleLineCount = title.split("\n").length;
					const footerLineCount = footer.split("\n").length + instructions.length + 1;
					return `${title}${prefix}${limitOptions({
						output: opts.output,
						options: this.options,
						cursor: this.cursor,
						maxItems: opts.maxItems,
						columnPadding: 2,
						rowPadding: titleLineCount + footerLineCount,
						style: styleOption
					}).join(`\n${prefix}`)}\n${hint}\n${footer}\n`;
				}
				default: {
					const prefix = hasGuide ? `${color.blue(S_BAR)} ` : nestedPrefix;
					const titleLineCount = title.split("\n").length;
					const footerLineCount = instructions.length + (hasGuide ? 2 : 1);
					return `${title}${prefix}${limitOptions({
						output: opts.output,
						options: this.options,
						cursor: this.cursor,
						maxItems: opts.maxItems,
						columnPadding: 2,
						rowPadding: titleLineCount + footerLineCount,
						style: styleOption
					}).join(`\n${prefix}`)}\n${hint}${hasGuide ? `\n${color.blue(S_BAR_END)}` : ""}\n`;
				}
			}
		}
	}).prompt();
};
//#endregion
//#region src/note.ts
/** A compact, enclosed note. Guide bars never replace its side borders. */
const note = (message = "", title = "", opts) => {
	const content = opts?.format ? message.split("\n").map(opts.format).join("\n") : message;
	box(`\n${content}\n`, title, {
		...opts,
		width: "auto",
		rounded: true,
		formatBorder: color.gray
	});
};
//#endregion
//#region src/password.ts
const password = (opts) => {
	return new PasswordPrompt({
		validate: opts.validate,
		mask: opts.mask ?? S_PASSWORD_MASK,
		signal: opts.signal,
		input: opts.input,
		accessible: opts.accessible,
		output: opts.output,
		render() {
			const hasGuide = getGuide(opts);
			const nestedPrefix = "  ";
			const title = promptTitle(opts.message, this.state, opts);
			const userInput = !this.userInput && opts.placeholder ? color.dim(opts.placeholder) : this.userInputWithCursor;
			const masked = this.masked;
			switch (this.state) {
				case "validating": {
					const prefix = hasGuide ? `${color.blue(S_BAR)} ` : nestedPrefix;
					return `${title}${prefix}${color.dim(masked ?? "")}\n${prefix}${color.dim("Validating…")}\n`;
				}
				case "error": {
					const errorPrefix = hasGuide ? `${color.yellow(S_BAR)} ` : nestedPrefix;
					const errorPrefixEnd = hasGuide ? `${color.yellow(S_BAR_END)} ` : "";
					const maskedText = masked ?? "";
					if (opts.clearOnError) this.clear();
					return `${title.trim()}\n${errorPrefix}${maskedText}\n${wrapTextWithPrefix(opts.output, color.yellow(this.error), hasGuide ? errorPrefixEnd : nestedPrefix)}\n`;
				}
				case "submit": return `${title}${hasGuide ? `${color.gray(S_BAR)} ` : nestedPrefix}${masked ? color.dim(masked) : ""}\n`;
				case "cancel": return `${title}${hasGuide ? `${color.gray(S_BAR)} ` : nestedPrefix}${masked ? color.strikethrough(color.dim(masked)) : ""}${masked && hasGuide ? `\n${color.gray(S_BAR)}` : ""}\n`;
				default: {
					const defaultPrefix = hasGuide ? `${color.blue(S_BAR)} ` : nestedPrefix;
					const defaultPrefixEnd = hasGuide ? color.blue(S_BAR_END) : "";
					return `${title}${defaultPrefix}${userInput}${hasGuide ? `\n${defaultPrefixEnd}` : ""}\n`;
				}
			}
		}
	}).prompt();
};
//#endregion
//#region src/path.ts
/**
* The `path` prompt extends `autocomplete` to provide file and directory suggestions.
*
* @see https://bomb.sh/docs/clack/packages/prompts/#path-selection
*
* @example
* ```ts
* import { path } from '@voidzero-dev/vite-plus-prompts';
*
* const result = await path({
*   message: 'Select a file:',
*   root: process.cwd(),
*   directory: false,
* });
* ```
*/
const path = (opts) => {
	const validate = opts.validate;
	return autocomplete({
		...opts,
		initialUserInput: opts.initialValue ?? opts.root ?? process.cwd(),
		maxItems: 5,
		completeOnTab: true,
		validate(value) {
			if (Array.isArray(value)) return;
			if (!value) return "Please select a path";
			if (validate) return runValidation(validate, value);
		},
		options() {
			const userInput = this.userInput;
			if (userInput === "") return [];
			try {
				let searchPath;
				if (!existsSync(userInput)) searchPath = dirname(userInput);
				else if (lstatSync(userInput).isDirectory() && (!opts.directory || userInput.endsWith("/"))) searchPath = userInput;
				else searchPath = dirname(userInput);
				const prefix = userInput.length > 1 && userInput.endsWith("/") ? userInput.slice(0, -1) : userInput;
				return readdirSync(searchPath).map((item) => {
					const path = join(searchPath, item);
					return {
						name: item,
						path,
						isDirectory: lstatSync(path).isDirectory()
					};
				}).filter(({ path, isDirectory }) => path.startsWith(prefix) && (isDirectory || !opts.directory)).map((item) => ({ value: item.path }));
			} catch {
				return [];
			}
		}
	});
};
//#endregion
//#region src/spinner.ts
const defaultStyleFn = color.blue;
const removeTrailingDots = (msg) => {
	return msg.replace(/\.+$/, "");
};
const formatTimer = (durationMs) => {
	const duration = durationMs / 1e3;
	const min = Math.floor(duration / 60);
	const secs = Math.floor(duration % 60);
	return color.gray(min > 0 ? `(${min}m ${secs}s)` : `(${secs}s)`);
};
const spinner = ({ indicator = "dots", onCancel, output = process.stdout, cancelMessage, errorMessage, frames = unicode ? [
	"◒",
	"◐",
	"◓",
	"◑"
] : [
	"•",
	"o",
	"O",
	"0"
], delay = unicode ? 80 : 120, signal, ...opts } = {}) => {
	const isCI$1 = isCI() || !isTTY(output) || isAccessible(opts.accessible);
	let unblock;
	let loop;
	let isSpinnerActive = false;
	let isCancelled = false;
	let _message = "";
	let _prevMessage;
	let _origin = performance.now();
	let _elapsedMs = 0;
	const columns = getColumns(output);
	const styleFn = opts?.styleFrame ?? defaultStyleFn;
	const getElapsedMs = () => {
		if (!isSpinnerActive) return _elapsedMs;
		return _elapsedMs + (performance.now() - _origin);
	};
	const handleExit = (code) => {
		const msg = code > 1 ? errorMessage ?? settings$1.messages.error : cancelMessage ?? settings$1.messages.cancel;
		isCancelled = code === 1;
		if (isSpinnerActive) {
			_stop(msg, code);
			if (isCancelled && typeof onCancel === "function") onCancel();
		}
	};
	const errorEventHandler = () => handleExit(2);
	const signalEventHandler = () => handleExit(1);
	const registerHooks = () => {
		process.on("uncaughtExceptionMonitor", errorEventHandler);
		process.on("unhandledRejection", errorEventHandler);
		process.on("SIGINT", signalEventHandler);
		process.on("SIGTERM", signalEventHandler);
		process.on("exit", handleExit);
		if (signal) signal.addEventListener("abort", signalEventHandler);
	};
	const clearHooks = () => {
		process.removeListener("uncaughtExceptionMonitor", errorEventHandler);
		process.removeListener("unhandledRejection", errorEventHandler);
		process.removeListener("SIGINT", signalEventHandler);
		process.removeListener("SIGTERM", signalEventHandler);
		process.removeListener("exit", handleExit);
		if (signal) signal.removeEventListener("abort", signalEventHandler);
	};
	const clearPrevMessage = () => {
		if (_prevMessage === void 0) return;
		if (isCI$1) return;
		const prevLines = wrapAnsi(_prevMessage, columns, {
			hard: true,
			trim: false
		}).split("\n");
		if (prevLines.length > 1) output.write(cursor.up(prevLines.length - 1));
		output.write(cursor.to(0));
		output.write(erase.down());
	};
	const hasGuide = getGuide(opts);
	const startLoop = () => {
		isSpinnerActive = true;
		unblock = isCI$1 ? () => {} : block({ output });
		_origin = performance.now();
		_prevMessage = void 0;
		if (hasGuide) output.write(`${color.gray(S_BAR)}\n`);
		let frameIndex = 0;
		let indicatorTimer = 0;
		registerHooks();
		const renderFrame = () => {
			if (isCI$1 && _prevMessage !== void 0) return;
			clearPrevMessage();
			const frame = styleFn(frames[frameIndex] ?? (unicode ? "◒" : "o"));
			let outputMessage;
			if (isCI$1) outputMessage = `${frame} ${_message}...`;
			else if (indicator === "timer") outputMessage = `${frame} ${_message} ${formatTimer(getElapsedMs())}`;
			else {
				const loadingDots = ".".repeat(Math.floor(indicatorTimer)).slice(0, 3);
				outputMessage = `${frame} ${_message}${loadingDots}`;
			}
			const wrapped = wrapAnsi(outputMessage, columns, {
				hard: true,
				trim: false
			});
			output.write(isCI$1 ? `${wrapped}\n` : wrapped);
			_prevMessage = wrapped;
			frameIndex = frameIndex + 1 < frames.length ? frameIndex + 1 : 0;
			indicatorTimer = indicatorTimer < 4 ? indicatorTimer + .125 : 0;
		};
		renderFrame();
		if (!isCI$1) loop = setInterval(renderFrame, delay);
		if (signal?.aborted) signalEventHandler();
	};
	const start = (msg = "") => {
		if (isSpinnerActive) return;
		isCancelled = false;
		_elapsedMs = 0;
		_message = removeTrailingDots(msg);
		startLoop();
	};
	const _stop = (msg = "", code = 0, silent = false, preserveElapsed = false) => {
		if (!isSpinnerActive) return;
		const elapsedMs = getElapsedMs();
		isSpinnerActive = false;
		isCancelled = code === 1;
		clearInterval(loop);
		clearPrevMessage();
		const step = code === 0 ? completeColor(S_STEP_SUBMIT) : code === 1 ? color.red(S_STEP_CANCEL) : color.red(S_STEP_ERROR);
		_message = msg ?? _message;
		if (!silent) {
			if (indicator === "timer") output.write(`${step} ${_message} ${formatTimer(elapsedMs)}\n`);
			else output.write(`${step} ${_message}\n`);
		}
		if (!preserveElapsed) _elapsedMs = 0;
		_prevMessage = void 0;
		clearHooks();
		unblock?.();
	};
	const pause = () => {
		if (!isSpinnerActive) return;
		_elapsedMs = getElapsedMs();
		_stop(_message, 0, true, true);
	};
	const resume = (msg = _message) => {
		if (isSpinnerActive) return;
		_message = removeTrailingDots(msg);
		startLoop();
	};
	const stop = (msg = "") => _stop(msg, 0);
	const cancel = (msg = "") => _stop(msg, 1);
	const error = (msg = "") => _stop(msg, 2);
	const clear = () => _stop("", 0, true);
	const message = (msg = "") => {
		_message = removeTrailingDots(msg ?? _message);
	};
	return {
		start,
		pause,
		resume,
		stop,
		message,
		cancel,
		error,
		clear,
		get isCancelled() {
			return isCancelled;
		}
	};
};
//#endregion
//#region src/progress-bar.ts
const S_PROGRESS_CHAR = {
	light: unicodeOr("─", "-"),
	heavy: unicodeOr("━", "="),
	block: unicodeOr("█", "#")
};
function progress({ style = "heavy", max: userMax = 100, size: userSize = 40, ...spinnerOptions } = {}) {
	const spin = spinner(spinnerOptions);
	let value = 0;
	let previousMessage = "";
	const max = Math.max(1, userMax);
	const size = Math.max(1, userSize);
	const activeStyle = (state) => {
		switch (state) {
			case "initial":
			case "active": return color.blue;
			case "error":
			case "cancel": return color.red;
			case "submit": return completeColor;
			default: return color.blue;
		}
	};
	const drawProgress = (state, msg) => {
		const active = Math.floor(value / max * size);
		return `${activeStyle(state)(S_PROGRESS_CHAR[style].repeat(active))}${color.dim(S_PROGRESS_CHAR[style].repeat(size - active))} ${msg}`;
	};
	const start = (msg = "") => {
		previousMessage = msg;
		spin.start(drawProgress("initial", msg));
	};
	const advance = (step = 1, msg) => {
		value = Math.min(max, step + value);
		spin.message(drawProgress("active", msg ?? previousMessage));
		previousMessage = msg ?? previousMessage;
	};
	return {
		start,
		pause: spin.pause.bind(spin),
		resume: (msg) => {
			const nextMessage = msg ?? previousMessage;
			previousMessage = nextMessage;
			spin.resume(drawProgress("active", nextMessage));
		},
		stop: spin.stop.bind(spin),
		cancel: spin.cancel.bind(spin),
		error: spin.error.bind(spin),
		clear: spin.clear.bind(spin),
		advance,
		message: (msg) => advance(0, msg),
		get isCancelled() {
			return spin.isCancelled;
		}
	};
}
//#endregion
//#region src/select.ts
const computeLabel = (label, format) => {
	if (!label.includes("\n")) return format(label);
	return label.split("\n").map((line) => format(line)).join("\n");
};
const select = (opts) => {
	const withMarker = (marker, label, format, suffix = "") => optionText(opts.output, `${marker} `, label, format, suffix);
	const opt = (option, state) => {
		if (!option) return "";
		const label = option.label ?? String(option.value);
		const hint = option.hint ? `: ${color.gray(option.hint)}` : "";
		switch (state) {
			case "disabled": return withMarker(color.gray(" "), label, (text) => color.strikethrough(color.gray(text)), option.hint ? `: ${color.gray(option.hint ?? "disabled")}` : "");
			case "selected": return computeLabel(label, color.dim);
			case "active": return withMarker(color.blue(S_POINTER_ACTIVE), label, (text) => color.blue(color.bold(text)), hint);
			case "cancelled": return computeLabel(label, (str) => color.strikethrough(color.dim(str)));
			default: return withMarker(color.dim(" "), label, color.dim);
		}
	};
	return new SelectPrompt({
		options: opts.options,
		signal: opts.signal,
		input: opts.input,
		accessible: opts.accessible,
		output: opts.output,
		initialValue: opts.initialValue,
		render() {
			const hasGuide = getGuide(opts);
			const nestedPrefix = "  ";
			const title = promptTitle(opts.message, this.state, opts);
			switch (this.state) {
				case "submit": {
					const submitPrefix = hasGuide ? `${color.gray(S_BAR)} ` : nestedPrefix;
					return `${title}${wrapTextWithPrefix(opts.output, opt(this.options[this.cursor], "selected"), submitPrefix)}\n${promptMilestone("select", opts.testId, "submit")}`;
				}
				case "cancel": {
					const cancelPrefix = hasGuide ? `${color.gray(S_BAR)} ` : nestedPrefix;
					return `${title}${wrapTextWithPrefix(opts.output, opt(this.options[this.cursor], "cancelled"), cancelPrefix)}${hasGuide ? `\n${color.gray(S_BAR)}` : ""}\n${promptMilestone("select", opts.testId, "cancel")}`;
				}
				default: {
					const prefix = hasGuide ? `${color.blue(S_BAR)} ` : nestedPrefix;
					const footer = opts.showInstructions === false ? [] : formatInstructionFooter(SELECT_INSTRUCTIONS, hasGuide, opts.output);
					if (hasGuide) footer.push(color.blue(S_BAR_END));
					const prefixEnd = footer.join("\n");
					const titleLineCount = title ? title.split("\n").length : 0;
					const footerLineCount = footer.length + 1;
					return `${title}${prefix}${limitOptions({
						output: opts.output,
						cursor: this.cursor,
						options: this.options,
						maxItems: opts.maxItems,
						columnPadding: 2,
						rowPadding: titleLineCount + footerLineCount,
						style: (item, active) => opt(item, item.disabled ? "disabled" : active ? "active" : "inactive")
					}).join(`\n${prefix}`)}\n${prefixEnd}\n${promptMilestone("select", opts.testId, String(this.cursor))}`;
				}
			}
		}
	}).prompt();
};
//#endregion
//#region src/select-key.ts
const selectKey = (opts) => {
	const withMarker = (marker, value) => optionText(opts.output, `${marker} `, value, (text) => text);
	const opt = (option, state = "inactive") => {
		if (!option) return "";
		const label = option.label ?? option.value;
		if (state === "selected") return color.dim(label);
		if (state === "cancelled") return color.strikethrough(color.dim(label));
		if (state === "active") return withMarker(color.blue(S_POINTER_ACTIVE), `${color.blue(`[${option.value}]`)} ${color.blue(color.bold(label))}${option.hint ? ` ${color.dim(`(${option.hint})`)}` : ""}`);
		return withMarker(color.dim(" "), color.dim(`[${option.value}] ${label}`));
	};
	return new SelectKeyPrompt({
		options: opts.options,
		signal: opts.signal,
		input: opts.input,
		accessible: opts.accessible,
		output: opts.output,
		initialValue: opts.initialValue,
		caseSensitive: opts.caseSensitive,
		render() {
			const hasGuide = getGuide(opts);
			const nestedPrefix = "  ";
			const title = promptTitle(opts.message, this.state, opts);
			switch (this.state) {
				case "submit": {
					const submitPrefix = hasGuide ? `${color.gray(S_BAR)} ` : nestedPrefix;
					const selectedOption = this.options.find((opt) => opt.value === this.value) ?? opts.options[0];
					return `${title}${wrapTextWithPrefix(opts.output, opt(selectedOption, "selected"), submitPrefix)}\n`;
				}
				case "cancel": {
					const cancelPrefix = hasGuide ? `${color.gray(S_BAR)} ` : nestedPrefix;
					return `${title}${wrapTextWithPrefix(opts.output, opt(this.options[0], "cancelled"), cancelPrefix)}${hasGuide ? `\n${color.gray(S_BAR)}` : ""}\n`;
				}
				default: {
					const defaultPrefix = hasGuide ? `${color.blue(S_BAR)} ` : nestedPrefix;
					const defaultPrefixEnd = hasGuide ? color.blue(S_BAR_END) : "";
					return `${title}${this.options.map((option, i) => wrapTextWithPrefix(opts.output, opt(option, i === this.cursor ? "active" : "inactive"), defaultPrefix)).join("\n")}${hasGuide ? `\n${defaultPrefixEnd}` : ""}\n`;
				}
			}
		}
	}).prompt();
};
//#endregion
//#region src/stream.ts
const prefix = "  ";
const stream = {
	message: async (iterable, { symbol = "" } = {}) => {
		process.stdout.write(symbol ? `${symbol} ` : "");
		const initialWidth = symbol ? 2 : 0;
		let lineWidth = initialWidth;
		for await (let chunk of iterable) {
			chunk = chunk.replace(/\n/g, `\n${prefix}`);
			if (chunk.includes("\n")) lineWidth = initialWidth + stripVTControlCharacters(chunk.slice(chunk.lastIndexOf("\n"))).length;
			const chunkLen = stripVTControlCharacters(chunk).length;
			if (lineWidth + chunkLen < process.stdout.columns) {
				lineWidth += chunkLen;
				process.stdout.write(chunk);
			} else {
				process.stdout.write(`\n${prefix}${chunk.trimStart()}`);
				lineWidth = initialWidth + stripVTControlCharacters(chunk.trimStart()).length;
			}
		}
		process.stdout.write("\n");
	},
	info: (iterable) => {
		return stream.message(iterable, { symbol: color.blue(S_INFO) });
	},
	success: (iterable) => {
		return stream.message(iterable, { symbol: completeColor(S_SUCCESS) });
	},
	step: (iterable) => {
		return stream.message(iterable, { symbol: completeColor(S_STEP_SUBMIT) });
	},
	warn: (iterable) => {
		return stream.message(iterable, { symbol: color.yellow(S_WARN) });
	},
	/** alias for `log.warn()`. */
	warning: (iterable) => {
		return stream.warn(iterable);
	},
	error: (iterable) => {
		return stream.message(iterable, { symbol: color.red(S_ERROR) });
	}
};
//#endregion
//#region src/task.ts
/**
* Define a group of tasks to be executed
*/
const tasks = async (tasks, opts) => {
	for (const task of tasks) {
		if (task.enabled === false) continue;
		const s = spinner(opts);
		s.start(task.title);
		const result = await task.task(s.message.bind(s));
		s.stop(result || task.title);
	}
};
//#endregion
//#region src/task-log.ts
const stripDestructiveANSI = (input) => {
	return input.replace(/\x1b\[(?:\d+;)*\d*[ABCDEFGHfJKSTsu]|\x1b\[(s|u)/g, "");
};
/**
* Renders a log which clears on success and remains on failure
*/
const taskLog = (opts) => {
	const output = opts.output ?? process.stdout;
	const columns = getColumns(output);
	const secondarySymbol = color.gray(S_BAR);
	const spacing = opts.spacing ?? 0;
	const hasGuide = getGuide(opts);
	const barSize = hasGuide ? 2 : 0;
	const retainLog = opts.retainLog === true;
	const isTTY$1 = !isCI() && isTTY(output);
	if (hasGuide) output.write(`${secondarySymbol}\n`);
	output.write(`${completeColor(S_STEP_SUBMIT)} ${opts.title}\n`);
	for (let i = 0; i < spacing; i++) output.write(`${hasGuide ? secondarySymbol : ""}\n`);
	const buffers = [{
		value: "",
		full: ""
	}];
	let lastMessageWasRaw = false;
	const clear = (clearTitle) => {
		if (!isTTY$1 || buffers.length === 0) return;
		let lines = 0;
		if (clearTitle) lines += spacing + 1 + (hasGuide ? 1 : 0);
		for (const buffer of buffers) {
			const { value, result } = buffer;
			let text = result?.message ?? value;
			if (text.length === 0) continue;
			if (result === void 0 && buffer.header !== void 0 && buffer.header !== "") text += `\n${buffer.header}`;
			const bufferHeight = text.split("\n").reduce((count, line) => {
				if (line === "") return count + 1;
				return count + Math.ceil((fastStringWidth$1(line) + (result ? 2 : barSize)) / columns);
			}, 0);
			lines += bufferHeight;
		}
		if (lines > 0) {
			lines += 1;
			output.write(erase.lines(lines));
		}
	};
	const printBuffer = (buffer, messageSpacing, full) => {
		const messages = full ? `${buffer.full}\n${buffer.value}` : buffer.value;
		if (buffer.header !== void 0 && buffer.header !== "") log.message(buffer.header.split("\n").map(color.bold), {
			output,
			withGuide: hasGuide,
			secondarySymbol,
			symbol: hasGuide ? secondarySymbol : void 0,
			spacing: 0
		});
		log.message(messages.split("\n").map(color.dim), {
			output,
			withGuide: hasGuide,
			secondarySymbol,
			symbol: hasGuide ? secondarySymbol : void 0,
			spacing: messageSpacing ?? spacing
		});
	};
	const renderBuffer = () => {
		for (const buffer of buffers) {
			const { header, value, full } = buffer;
			if ((header === void 0 || header.length === 0) && value.length === 0) continue;
			printBuffer(buffer, void 0, retainLog === true && full.length > 0);
		}
	};
	const message = (buffer, msg, mopts) => {
		clear(false);
		if ((mopts?.raw !== true || !lastMessageWasRaw) && buffer.value !== "") buffer.value += "\n";
		buffer.value += stripDestructiveANSI(msg);
		lastMessageWasRaw = mopts?.raw === true;
		if (opts.limit !== void 0) {
			const lines = buffer.value.split("\n");
			const linesToRemove = lines.length - opts.limit;
			if (linesToRemove > 0) {
				const removedLines = lines.splice(0, linesToRemove);
				if (retainLog) buffer.full += (buffer.full === "" ? "" : "\n") + removedLines.join("\n");
			}
			buffer.value = lines.join("\n");
		}
		if (isTTY$1) printBuffers();
	};
	const printBuffers = () => {
		for (const buffer of buffers) if (buffer.result) {
			if (buffer.result.status === "error") log.error(buffer.result.message, {
				output,
				withGuide: hasGuide,
				secondarySymbol,
				spacing: 0
			});
			else log.success(buffer.result.message, {
				output,
				withGuide: hasGuide,
				secondarySymbol,
				spacing: 0
			});
		} else if (buffer.value !== "") printBuffer(buffer, 0);
	};
	const completeBuffer = (buffer, result) => {
		clear(false);
		buffer.result = result;
		if (isTTY$1) printBuffers();
	};
	return {
		message(msg, mopts) {
			message(buffers[0], msg, mopts);
		},
		group(name) {
			const buffer = {
				header: name,
				value: "",
				full: ""
			};
			buffers.push(buffer);
			return {
				message(msg, mopts) {
					message(buffer, msg, mopts);
				},
				error(message) {
					completeBuffer(buffer, {
						status: "error",
						message
					});
				},
				success(message) {
					completeBuffer(buffer, {
						status: "success",
						message
					});
				}
			};
		},
		error(message, opts) {
			clear(true);
			log.error(message, {
				output,
				withGuide: hasGuide,
				secondarySymbol,
				spacing
			});
			if (opts?.showLog !== false) renderBuffer();
			buffers.splice(1, buffers.length - 1);
			buffers[0].value = "";
			buffers[0].full = "";
		},
		success(message, opts) {
			clear(true);
			log.success(message, {
				output,
				withGuide: hasGuide,
				secondarySymbol,
				spacing: 1
			});
			if (opts?.showLog === true) renderBuffer();
			buffers.splice(1, buffers.length - 1);
			buffers[0].value = "";
			buffers[0].full = "";
		}
	};
};
//#endregion
//#region src/text.ts
const text = (opts) => {
	return new TextPrompt({
		validate: opts.validate,
		placeholder: opts.placeholder,
		defaultValue: opts.defaultValue,
		initialValue: opts.initialValue,
		output: opts.output,
		signal: opts.signal,
		input: opts.input,
		accessible: opts.accessible,
		render() {
			const hasGuide = getGuide(opts);
			const nestedPrefix = "  ";
			const title = promptTitle(opts.message, this.state, opts);
			const placeholder = opts.placeholder ? color.inverse(opts.placeholder[0]) + color.dim(opts.placeholder.slice(1)) : color.inverse(color.hidden("_"));
			const userInput = !this.userInput ? placeholder : this.userInputWithCursor;
			const value = this.value ?? "";
			switch (this.state) {
				case "validating": {
					const prefix = hasGuide ? `${color.blue(S_BAR)} ` : nestedPrefix;
					return `${title}${prefix}${color.dim(value)}\n${prefix}${color.dim("Validating…")}\n`;
				}
				case "error": {
					const errorText = this.error ? wrapTextWithPrefix(opts.output, color.yellow(this.error), hasGuide ? `${color.yellow(S_BAR_END)} ` : nestedPrefix) : "";
					const errorPrefix = hasGuide ? `${color.yellow(S_BAR)} ` : nestedPrefix;
					return `${title.trim()}\n${errorPrefix}${userInput}\n${errorText}\n${promptMilestone("text", opts.testId, "error")}`;
				}
				case "submit": {
					const valueText = value ? color.dim(value) : "";
					return `${title}${hasGuide ? `${color.gray(S_BAR)} ` : nestedPrefix}${valueText}\n${promptMilestone("text", opts.testId, "submit")}`;
				}
				case "cancel": {
					const valueText = value ? color.strikethrough(color.dim(value)) : "";
					const cancelPrefix = hasGuide ? `${color.gray(S_BAR)} ` : nestedPrefix;
					return `${title}${cancelPrefix}${valueText}${value.trim() ? `\n${cancelPrefix}` : ""}\n${promptMilestone("text", opts.testId, "cancel")}`;
				}
				default: {
					const defaultPrefix = hasGuide ? `${color.blue(S_BAR)} ` : nestedPrefix;
					const defaultPrefixEnd = hasGuide ? color.blue(S_BAR_END) : "";
					return `${title}${defaultPrefix}${userInput}${hasGuide ? `\n${defaultPrefixEnd}` : ""}\n${promptMilestone("text", opts.testId, this.value ?? "")}`;
				}
			}
		}
	}).prompt();
};
//#endregion
export { CANCEL_SYMBOL, MULTISELECT_INSTRUCTIONS, SELECT_INSTRUCTIONS, S_BAR, S_BAR_END, S_BAR_END_RIGHT, S_BAR_H, S_BAR_START, S_BAR_START_RIGHT, S_CHECKBOX_ACTIVE, S_CHECKBOX_INACTIVE, S_CHECKBOX_SELECTED, S_CONNECT_LEFT, S_CORNER_BOTTOM_LEFT, S_CORNER_BOTTOM_RIGHT, S_CORNER_TOP_LEFT, S_CORNER_TOP_RIGHT, S_ERROR, S_INFO, S_PASSWORD_MASK, S_POINTER_ACTIVE, S_POINTER_INACTIVE, S_RADIO_ACTIVE, S_RADIO_INACTIVE, S_STEP_ACTIVE, S_STEP_CANCEL, S_STEP_ERROR, S_STEP_SUBMIT, S_SUCCESS, S_WARN, autocomplete, autocompleteMultiselect, box, cancel, completeColor, confirm, formatInstructionFooter, getGuide, group, groupMultiselect, intro, isCI, isCancel, isTTY, limitOptions, log, milestone, multiselect, note, optionText, outro, password, path, progress, promptMilestone, promptTitle, select, selectKey, settings, spinner, stream, symbol, symbolBar, taskLog, tasks, text, unicode, unicodeOr, updateSettings, wrapTextWithPrefix };
