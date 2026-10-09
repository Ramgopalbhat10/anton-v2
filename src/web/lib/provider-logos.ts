/*
 * Model vendors' logos, from LobeHub's MIT-licensed set
 * (@lobehub/icons-static-svg). Each is inlined as SVG text so one-colour
 * logos take the text colour. Only the files listed here are bundled; a
 * vendor without one keeps its initials.
 */
import ai21 from '@lobehub/icons-static-svg/icons/ai21.svg?raw';
import alibaba from '@lobehub/icons-static-svg/icons/alibaba-color.svg?raw';
import anthropic from '@lobehub/icons-static-svg/icons/anthropic.svg?raw';
import arcee from '@lobehub/icons-static-svg/icons/arcee-color.svg?raw';
import aws from '@lobehub/icons-static-svg/icons/aws-color.svg?raw';
import baidu from '@lobehub/icons-static-svg/icons/baidu-color.svg?raw';
import bytedance from '@lobehub/icons-static-svg/icons/bytedance-color.svg?raw';
import cohere from '@lobehub/icons-static-svg/icons/cohere-color.svg?raw';
import deepseek from '@lobehub/icons-static-svg/icons/deepseek-color.svg?raw';
import dotsstudio from '@lobehub/icons-static-svg/icons/dotsstudio.svg?raw';
import fireworks from '@lobehub/icons-static-svg/icons/fireworks-color.svg?raw';
import google from '@lobehub/icons-static-svg/icons/google-color.svg?raw';
import ibm from '@lobehub/icons-static-svg/icons/ibm.svg?raw';
import inception from '@lobehub/icons-static-svg/icons/inception.svg?raw';
import liquid from '@lobehub/icons-static-svg/icons/liquid.svg?raw';
import longcat from '@lobehub/icons-static-svg/icons/longcat-color.svg?raw';
import meta from '@lobehub/icons-static-svg/icons/meta-color.svg?raw';
import microsoft from '@lobehub/icons-static-svg/icons/microsoft-color.svg?raw';
import minimax from '@lobehub/icons-static-svg/icons/minimax-color.svg?raw';
import mistral from '@lobehub/icons-static-svg/icons/mistral-color.svg?raw';
import moonshot from '@lobehub/icons-static-svg/icons/moonshot.svg?raw';
import nvidia from '@lobehub/icons-static-svg/icons/nvidia-color.svg?raw';
import openai from '@lobehub/icons-static-svg/icons/openai.svg?raw';
import openrouter from '@lobehub/icons-static-svg/icons/openrouter-color.svg?raw';
import perceptron from '@lobehub/icons-static-svg/icons/perceptron.svg?raw';
import perplexity from '@lobehub/icons-static-svg/icons/perplexity-color.svg?raw';
import poolside from '@lobehub/icons-static-svg/icons/poolside-color.svg?raw';
import qwen from '@lobehub/icons-static-svg/icons/qwen-color.svg?raw';
import reka from '@lobehub/icons-static-svg/icons/reka.svg?raw';
import relace from '@lobehub/icons-static-svg/icons/relace.svg?raw';
import sakana from '@lobehub/icons-static-svg/icons/sakana-color.svg?raw';
import stepfun from '@lobehub/icons-static-svg/icons/stepfun-color.svg?raw';
import tencent from '@lobehub/icons-static-svg/icons/tencent-color.svg?raw';
import upstage from '@lobehub/icons-static-svg/icons/upstage-color.svg?raw';
import xai from '@lobehub/icons-static-svg/icons/xai.svg?raw';
import xiaomi from '@lobehub/icons-static-svg/icons/xiaomimimo.svg?raw';
import zai from '@lobehub/icons-static-svg/icons/zai.svg?raw';
import type { ModelInfo } from './api';

/** By the vendor part of a model id, as OpenRouter and the plans name vendors; aliases where those differ. */
const LOGOS: Record<string, string> = {
	ai21,
	alibaba,
	amazon: aws,
	anthropic,
	'arcee-ai': arcee,
	baidu,
	'bytedance-seed': bytedance,
	bytedance,
	cohere,
	deepseek,
	'dots-studio': dotsstudio,
	fireworks,
	google,
	'ibm-granite': ibm,
	inception,
	liquid,
	meituan: longcat,
	meta,
	'meta-llama': meta,
	microsoft,
	minimax,
	mistralai: mistral,
	moonshotai: moonshot,
	nvidia,
	openai,
	openrouter,
	perceptron,
	perplexity,
	poolside,
	qwen,
	rekaai: reka,
	relace,
	sakana,
	stepfun,
	tencent,
	upstage,
	'x-ai': xai,
	xiaomi,
	'z-ai': zai,
};

/** The vendor a model id names: `openrouter/anthropic/…` is Anthropic's, `openai/…` (a ChatGPT plan's) is OpenAI's. */
export function vendorSlug(model: Pick<ModelInfo, 'id'>): string {
	const [gateway, vendor] = model.id.split('/');
	return (gateway === 'openrouter' ? (vendor ?? gateway) : gateway).replace(/^~/, '').toLowerCase();
}

/** The vendor's logo as SVG markup, or undefined when the set has none for it. */
export function logoFor(model: Pick<ModelInfo, 'id'>): string | undefined {
	return LOGOS[vendorSlug(model)];
}
