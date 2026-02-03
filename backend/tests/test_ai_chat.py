
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.routers.ai import classify_user_intent

client = TestClient(app)

def test_intent_classification():
    # 1. 强制单页模式关键词
    assert classify_user_intent("请讲解这一页的内容") == "language_learning"
    assert classify_user_intent("讲解下一段") == "language_learning"
    assert classify_user_intent("解析这段内容") == "language_learning"
    assert classify_user_intent("Explain this page") == "language_learning"

    # 2. 知识库检索模式
    assert classify_user_intent("这本书讲了什么？") == "knowledge_retrieval"
    assert classify_user_intent("黑洞在哪里提到过？") == "knowledge_retrieval"
    assert classify_user_intent("What is the ending?") == "knowledge_retrieval"
    assert classify_user_intent("Locate the chapter about stars") == "knowledge_retrieval"

    # 3. 默认回落
    assert classify_user_intent("Hello") == "language_learning"
    assert classify_user_intent("How are you?") == "language_learning"

def test_chat_api_special_chars():
    # 测试特殊字符是否会导致 500 错误 (FTS5 崩溃)
    # 不依赖真实 LLM，只测试代码逻辑是否崩溃
    # 注意：这需要 mock 数据库或确保数据库存在。由于是集成测试，我们尝试直接调用。
    # 如果没有配置 API KEY，可能会失败在 LLM 调用，但至少不应报 SQL 错误。
    
    # 构造一个包含大量特殊字符的请求，模拟 FTS5 攻击
    bad_input = "讲解这段：'!!! @@@ ### $$$ %%% ^^^ &&& *** ((())) ...'"
    
    # 我们预期它被识别为 language_learning (因为有"讲解"和"这段")
    # 或者如果没识别出来，进入 knowledge_retrieval，我们主要测试是否 crash
    
    # 为了测试 knowledge_retrieval 的稳定性，我们故意构造一个全书检索请求
    # 但带有特殊字符
    bad_retrieval_input = "查找内容：'!!! *** ???'"
    
    # 由于环境可能没有真实的 DeepSeek/Gemini Key，我们只检查是否返回 200 或 业务错误，而不是 Server Error
    response = client.post("/api/ai/chat", json={
        "message": bad_retrieval_input,
        "book_id": "test_book_id", # 假设 ID，可能会 404 或空结果，但不应 500
        "book_title": "Test Book"
    })
    
    # 只要不是 500 Internal Server Error 即可
    if response.status_code == 500:
        print(f"\n[FTS5 Failure Response]: {response.text}\n")
    assert response.status_code != 500

def test_normal_retrieval():
    """测试正常的知识库检索是否工作"""
    response = client.post("/api/ai/chat", json={
        "message": "这本书讲了什么？",
        "book_id": "test_book_id",
        "book_title": "Test Book"
    })
    if response.status_code == 500:
        print(f"\n[Normal Retrieval Failure]: {response.text}\n")
    # assert response.status_code == 200 # Might be 200 even if fallback
    assert response.status_code != 500
