# PDF Word Lookup Acceptance

## Goal
PDF 阅读界面的点击查词应优先命中用户真正想查的英文单词，而不是：
- 破折号拼接串
- OCR 粘连词整串
- 标点或所有格残片
- 变形词无法回到原型

## Automated Checks
运行下面三个检查：

```bash
node frontend/scripts/verify-word-lookup-samples.mjs
./frontend/node_modules/.bin/tsc --noEmit -p frontend/tsconfig.json
./backend/.venv/bin/python -m pytest backend/tests/test_lookup_normalizer.py backend/tests/test_dict_lemma.py -q
```

## Manual Checklist
在 PDF 阅读页逐项点测：

1. 破折号左右词
文本样例：
`dust—usually`
`sand—hits`
预期：
点左边命中左词，点右边命中右词，不得把整串作为一个词查询。

2. OCR 粘连词
文本样例：
`streaksof`
预期：
点击左半部分优先命中 `streaks`，点击右半部分命中 `of`。

3. 词形还原
文本样例：
`spotted`
`formed`
`hits`
`fleeting`
预期：
查词失败时应能合理回退到原型或更基础词形，不应直接无结果。

4. 所有格和缩写
文本样例：
`John's`
`it's`
预期：
`John's` 应按 `john` 查词；
`it's` 应保留缩写，不应错误截断成 `it`。

5. 正常长单词
文本样例：
`atmosphere`
`fleeting`
预期：
不应被错误拆分成多个子词。

6. 上下文句子
点击查词后，右侧词典的上下文应仍是整句，而不是只剩被点击 token。

## Sample Sentence
建议固定复测这句：

```text
Have you ever spotted a shooting star? These fleeting streaksof light are formed when a tiny piece of space dust—usually about the size of a grain of sand—hits our atmosphere.
```

重点检查：
- `spotted`
- `streaksof`
- `dust—usually`
- `sand—hits`
- `formed`
- `fleeting`
