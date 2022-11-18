const regex = {
	// Matches any HTML tag and captures its type
	anyTag: /<\s*\/?\s*([^\s\/<>="']+)\s*((?:[^\s\/<>="']+(?:="[^"]*")?\s*)+)?\s*(\/)?\s*>/,
	// Matches closing HTML tag and captures its type
	endTag: /<\/\s*(\w+)\s*>/,
	// Matches HTML opening tag. Captures its type and raw attributes string
	openingTag: /<\s*([^\s\/<>="']+)\s*((?:[^\s\/<>="']+(?:="[^"]*")?\s*)+)?\s*(\/)?\s*>/,
	// Matches a single key/value? pair. Captures key and value
	attributes: /([^\s/"'=]+)(?:="([^"]*)")?/g,
	// Matches a comment
	comments: /<!--.+-->/g,
}

class Stack<T> extends Array<T> {
	peek() { return this[this.length - 1] }
}

interface Dict<T = any> { [key: string]: T }

interface VNode {
	type: string
	append(): void
	props: Dict<any>
	children: VNode[]
	static: boolean
	nodeValue?: string
}

// JS has no builtin way to collect all the matches and include capture groups for regular expressions. Yikes.
// Hence, a helper to do just that
function findAll(str: string, regex: RegExp, matches: RegExpExecArray[] = []): RegExpExecArray[] {
	const match = regex.exec(str)
	match && matches.push(match) && findAll(str, regex, matches)
	return matches
}

const sandboxProxies = new WeakMap()

export function saferEval(code: string) {
	code = `with(sandbox) {${code}}`
	const func = new Function("sandbox", code)

	const has = (target: Object, key: string) => true
	const get = (target: Object, key: any) => {
		if (key === Symbol.unscopables) return undefined
		else return (typeof target[key] === 'function' ? target[key].bind(target) : target[key])
	}

	return function evalWrapper(sandbox: Object) {
		let proxy = sandboxProxies.get(sandbox);
		if (!proxy) {
			proxy = new Proxy(sandbox, { has, get })
			sandboxProxies.set(sandbox, proxy)
		}
		return func(proxy)
	}
}

// Creates object containing the properties in the passed raw attribute string
function parseProps(propString: string): Dict {
	return findAll(propString, regex.attributes).reduce((props, pair) => {
		props[pair[1]] = pair[2] || true
		return props
	}, {} as any)
}

function parse(html: string, h: Function): any[] {
	const stack = new Stack<VNode>()
	const closed = new Set<VNode>()

	while (html !== '') {
		const nextTag = regex.anyTag.exec(html)
		if (!nextTag || nextTag.index) {
			const textContent = html.substr(0, nextTag ? nextTag.index : html.length).trim()
			if (textContent)
				stack.push(h('#text', null, textContent))
		}

		if (!nextTag) break

		const openingTag = regex.openingTag.exec(nextTag[0])
		if (openingTag) {
			const vn = h(
				openingTag[1],
				openingTag[2] ? parseProps(openingTag[2]) : {}
			)
			if (openingTag[3]) closed.add(vn)
			stack.push(vn)
		} else {
			const content = []

			let cur = stack.peek()
			while (cur && (cur.type !== nextTag[1] || closed.has(cur))) {
				content.unshift(stack.pop())
				cur = stack.peek()
			}

			const container = cur
			if (!container) throw new Error('No corresponding opening tag found for ' + nextTag[0])

			content.forEach(container.append.bind(container))
			closed.add(container)
		}
		html = html.slice(nextTag.index + nextTag[0].length)
	}
	return [...stack]
}

function detectStaticNodes(vn: VNode, options: CompilerOptions) {
	if (vn.type === '#text') vn.static = !vn.nodeValue?.search(options.interpolationRegex)
	else vn.static = 
		Object.keys(options.directives).every(d => !(d in vn.props)) && // No structural directives
		vn.children.every(c => detectStaticNodes(c, options)) && // No dynamic children
		Object.keys(vn.props).every(p => !options.dataBindingRegex.exec(p)) // No dynamically bound props
	return vn.static
}

function parseInterpolations(src: string, interpolationRegex) {
	return src.replace(interpolationRegex, (m, c1) => `' + ${c1} + '`)
}

function compileProps(props: Dict<any>, { dataBindingRegex}: CompilerOptions) {
	props = {...props}
	const hasKey = Object.keys(props).some(p => {
		if (p === 'key') return true
		const binding = dataBindingRegex.exec(p)
		return binding && binding[1] === 'key'
	})
	if (!hasKey) props['key'] = 'y-key-' + (Math.random() + '').slice(2)
	
	return `{${Object.entries(props).map((pair) => {
		const dataBinding = dataBindingRegex.exec(pair[0])
		if (dataBinding)
			return `${dataBinding[1]}: ${pair[1]}`
		else
			return `${pair[0]}: '${pair[1]}'`
	}).join(',')}}`
}

function compileNode(vn: VNode, options: CompilerOptions) {
	if (vn.type === '#text') return `h('#text', null, '${parseInterpolations(vn.nodeValue, options.interpolationRegex)}')`

	detectStaticNodes(vn, options)

	for (const prop in vn.props) if (prop in options.directives) {
		const value = vn.props[prop]
		delete vn.props[prop]
		return options.directives[prop](value, () => compileNode(vn, options))
	}
	return `h('${vn.type}',${compileProps(vn.props, options)},[${vn.children.map(c => compileNode(c, options)).join(',')}])`
}

export interface CompilerOptions {
	h: Function
	directives: Dict<Function>
	interpolationRegex: RegExp
	dataBindingRegex: RegExp
}

export function compile(template: string, options: CompilerOptions) {
	template = template.replace(regex.comments, '')
	const code = compileNode(parse(template, options.h)[0], options)
	const innerRender = saferEval('return ' + code)
	return function renderTemplate(h: Function) {
		const scope = Object.create(this)
		scope.h = options.h
		return innerRender(scope)
	}
}
