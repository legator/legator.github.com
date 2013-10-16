$(function () {
        $('#exp').highcharts({
            chart: {
                type: 'bar'
            },
            title: {
                text: 'Skills'
            },
            xAxis: {
                categories: ['php', 'C#', 'Java'],
                title: {
                    text: null
                }
            },
            yAxis: {
                min: 0,
                title: {
                    text: 'Years',
                    align: 'high'
                },
                labels: {
                    overflow: 'justify'
                }
            },
            tooltip: {
                headerFormat: '<b>{series.name}</b><br/>',
                pointFormat: '{point.y} year'
            },
            plotOptions: {
                bar: {
                    dataLabels: {
                        enabled: true
                    }
                }
            },
            legend: {
                enabled: false
            },
            credits: {
                enabled: false
            },
            series: [{
                name: 'Expirence',
                data: [3, 4.5, 3]
            }]
        });
    });