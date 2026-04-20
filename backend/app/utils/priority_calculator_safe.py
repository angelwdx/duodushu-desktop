from datetime import datetime, timedelta
from sqlalchemy import text


def calculate_priority_score(word: dict) -> float:
    """
    计算单词学习优先级分数（0-100）

    权重分配：
    - 查询频率: 40% （多次查询 = 学习困难）
    - 掌握度反比: 30% （掌握度低 = 需要学习）
    - 时间新鲜度: 20% （最近查询 = 优先级高）
    - 复习间隔: 10% （久未复习 = 可能需要复习）

    Args:
        word: 单词数据字典，包含：
            - query_count: 查询次数
            - mastery_level: 掌握度 (1-5)
            - last_queried_at: 最后查询时间
            - last_reviewed_at: 最后复习时间
            - created_at: 创建时间

    Returns:
        priority_score: 优先级分数 (0-100)
    """
    now = datetime.utcnow()

    # 1. 查询频率因子（40%权重）
    query_count = word.get("query_count") or 0
    # 归一化到 0-2 范围（10次查询达到最大值）
    query_factor = min(query_count / 10.0, 2.0)

    # 2. 掌握度反比因子（30%权重）
    mastery_level = word.get("mastery_level") or 1
    # 掌握度越低（1），因子越高（1）
    # 掌握度越高（5），因子越低（0）
    mastery_factor = (5 - mastery_level) / 4.0  # 0-1 范围

    # 3. 时间新鲜度因子（20%权重）
    last_queried = word.get("last_queried_at")
    if last_queried:
        # 安全转换：只计算查询新鲜度，不处理复习间隔
        try:
            last_queried_dt = datetime.fromisoformat(last_queried)
            days_since_query = (now - last_queried_dt).days
            recency_factor = max(0, 1 - days_since_query / 30.0)
        except (ValueError, TypeError):
            # 如果转换失败，不使用此字段
            last_queried_dt = None
            recency_factor = 0.5
    else:
        # 从未查询 = 中等优先级
        recency_factor = 0.5

    # 4. 复习间隔因子（10%权重）- 安全版本使用默认值
    # 在完整版本中，这会基于 last_reviewed_at 计算
    # 安全版本简化为固定中等值
    interval_factor = 0.5

    # 综合评分（加权平均）
    priority = (
        query_factor * 0.4  # 40% 权重
        + mastery_factor * 0.3  # 30% 权重
        + recency_factor * 0.2  # 20% 权重
        + interval_factor * 0.1  # 10% 权重
    ) * 100  # 转换为 0-100 分数

    # 确保在合理范围内
    priority = round(min(max(priority, 0), 100), 2)

    return priority


def get_learning_status(priority_score: float) -> str:
    """
    根据优先级分数返回学习状态

    Args:
        priority_score: 优先级分数

    Returns:
        status: 'urgent' | 'attention' | 'normal' | 'mastered'
    """
    if priority_score >= 80:
        return "urgent"  # 紧急：重点学习
    elif priority_score >= 60:
        return "attention"  # 关注：需要关注
    elif priority_score >= 40:
        return "normal"  # 正常：正常学习
    else:
        return "mastered"  # 已掌握


def batch_update_priorities(db_session) -> dict:
    """
    批量更新所有单词的优先级（安全版本）

    Args:
        db_session: SQLAlchemy Session

    Returns:
        stats: 更新统计信息
    """
    # 获取所有单词
    result = db_session.execute(
        text(
            "SELECT id, query_count, mastery_level, "
            "last_queried_at, last_reviewed_at, created_at "
            "FROM vocabulary"
        )
    )

    words = result.fetchall()

    updated_count = 0
    errors = []

    for word in words:
        try:
            # 安全提取值，处理 None 情况
            word_id = word[0]
            query_count = word[1] if word[1] is not None else 0
            mastery_level = word[2] if word[2] is not None else 1
            last_queried = word[3]
            last_reviewed = word[4]
            created_at = word[5]

            # 计算优先级
            word_dict = {
                "query_count": query_count,
                "mastery_level": mastery_level,
                "last_queried_at": last_queried,
                "last_reviewed_at": last_reviewed,
                "created_at": created_at,
            }

            priority = calculate_priority_score(word_dict)
            status = get_learning_status(priority)

            # 更新数据库
            db_session.execute(
                text(
                    "UPDATE vocabulary SET priority_score = :priority, learning_status = :status WHERE id = :vocab_id"
                ),
                {"priority": priority, "status": status, "vocab_id": word_id},
            )

            updated_count += 1

        except Exception as e:
            errors.append(f"单词ID {word[0]} 更新失败: {str(e)}")

    # 所有更新完成后统一提交，避免逐行提交的性能开销
    try:
        db_session.commit()
    except Exception as e:
        errors.append(f"批量提交失败: {str(e)}")

    return {"total": len(words), "updated": updated_count, "errors": errors}
