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
import cursor from '@lobehub/icons-static-svg/icons/cursor.svg?raw';
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
import opencode from '@lobehub/icons-static-svg/icons/opencode.svg?raw';
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
import atlascloud from '@lobehub/icons-static-svg/icons/atlascloud.svg?raw';
import azure from '@lobehub/icons-static-svg/icons/azure-color.svg?raw';
import baseten from '@lobehub/icons-static-svg/icons/baseten.svg?raw';
import bedrock from '@lobehub/icons-static-svg/icons/bedrock-color.svg?raw';
import cerebras from '@lobehub/icons-static-svg/icons/cerebras-color.svg?raw';
import chutes from '@lobehub/icons-static-svg/icons/chutes.svg?raw';
import cloudflare from '@lobehub/icons-static-svg/icons/cloudflare-color.svg?raw';
import crusoe from '@lobehub/icons-static-svg/icons/crusoe-color.svg?raw';
import deepinfra from '@lobehub/icons-static-svg/icons/deepinfra-color.svg?raw';
import featherless from '@lobehub/icons-static-svg/icons/featherless-color.svg?raw';
import friendli from '@lobehub/icons-static-svg/icons/friendli.svg?raw';
import gmicloud from '@lobehub/icons-static-svg/icons/gmicloud.svg?raw';
import groq from '@lobehub/icons-static-svg/icons/groq.svg?raw';
import hyperbolic from '@lobehub/icons-static-svg/icons/hyperbolic-color.svg?raw';
import lambda from '@lobehub/icons-static-svg/icons/lambda.svg?raw';
import nebius from '@lobehub/icons-static-svg/icons/nebius.svg?raw';
import novita from '@lobehub/icons-static-svg/icons/novita-color.svg?raw';
import parasail from '@lobehub/icons-static-svg/icons/parasail.svg?raw';
import sambanova from '@lobehub/icons-static-svg/icons/sambanova-color.svg?raw';
import siliconcloud from '@lobehub/icons-static-svg/icons/siliconcloud-color.svg?raw';
import together from '@lobehub/icons-static-svg/icons/together-color.svg?raw';
import vercel from '@lobehub/icons-static-svg/icons/vercel.svg?raw';
import venice from '@lobehub/icons-static-svg/icons/venice-color.svg?raw';
import vertex from '@lobehub/icons-static-svg/icons/vertexai-color.svg?raw';
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
	cursor,
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
	mistral,
	mistralai: mistral,
	moonshotai: moonshot,
	nvidia,
	openai,
	'opencode-go': opencode,
	openrouter,
	perceptron,
	perplexity,
	poolside,
	qwen,
	rekaai: reka,
	relace,
	sakana,
	stepfun,
	spacexai: xai,
	tencent,
	upstage,
	vercel,
	'x-ai': xai,
	xai,
	xiaomi,
	'z-ai': zai,
	zai,
};

/** The companies that host models, as a gateway's routes name them, where they are not also a maker above. */
const HOSTS: Record<string, string> = {
	'atlas-cloud': atlascloud,
	azure,
	baseten,
	bedrock,
	'amazon-bedrock': bedrock,
	cerebras,
	chutes,
	'claude-on-aws': aws,
	claudeaws: aws,
	cloudflare,
	crusoe,
	deepinfra,
	featherless,
	friendli,
	gmicloud,
	'google-vertex': vertex,
	'google-ai-studio': google,
	groq,
	hyperbolic,
	lambda,
	nebius,
	novita,
	parasail,
	sambanova,
	siliconflow: siliconcloud,
	together,
	togetherai: together,
	venice,
	vertex,
};

/** A hosting provider's logo by the slug a route names it with (`deepinfra/fp4` is DeepInfra's), or undefined when the set has none. */
export function hostLogo(slug: string): string | undefined {
	const name = slug.split('/')[0].toLowerCase();
	return HOSTS[name] ?? LOGOS[name] ?? LOGOS[name.replace(/ai$/, '')];
}

/**
 * The vendor a model id names: `openrouter/anthropic/…` and `vercel/anthropic/…` are Anthropic's, `openai/…` (a ChatGPT plan's) is OpenAI's,
 * and `claude-code/…` (a Claude plan's) is Anthropic's. `opencode-go/…` and `cursor/…` (key plans' models) take the plan's own logo.
 */
export function vendorSlug(model: Pick<ModelInfo, 'id'>): string {
	const [gateway, vendor] = model.id.split('/');
	if (gateway === 'claude-code') return 'anthropic';
	return (gateway === 'openrouter' || gateway === 'vercel' ? vendor || gateway : gateway).replace(/^~/, '').toLowerCase();
}

/** The vendor's logo as SVG markup, or undefined when the set has none for it. */
export function logoFor(model: Pick<ModelInfo, 'id'>): string | undefined {
	return LOGOS[vendorSlug(model)];
}
