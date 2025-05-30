import plotly.graph_objects as go

courses = ['Computer Network', 'Operating System Principles', 'Database System Principles and Practice',
           'Web Application Development', 'Linux System', 'Algorithm Design and Analysis']
weights = [1, 1, 1, 1, 1, 1]

# 只显示上半圆（0-180度）
fig = go.Figure(data=[go.Pie(
    labels=courses,
    values=weights,
    hole=.5,  # 创建圆环图
    rotation=90,  # 旋转90度，让第一个扇形从顶部开始
    direction='clockwise',  # 顺时针方向
    marker=dict(colors=['royalblue', 'cyan', 'green', 'yellow', 'orange', 'red']),
    textinfo='label',  # 只显示标签
    insidetextorientation='radial'
)])

# 更新布局，只显示上半圆
fig.update_layout(
    showlegend=False,
    height=500,
    width=500,
    margin=dict(l=0, r=0, t=0, b=0)
)

# 保存为HTML文件或显示
fig.write_html('semester_courses.html')
# fig.show()